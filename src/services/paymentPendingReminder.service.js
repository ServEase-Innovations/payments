import pool from "../config/db.js";
import {
  createInAppNotification,
  InAppTypes,
} from "./inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import {
  clampReminderInt,
  DEFAULT_PAYMENT_REMINDER_POLICY,
  parsePaymentPendingPolicy,
  resolveDuePaymentReminderTier,
} from "./paymentPendingReminderPolicy.js";

export {
  DEFAULT_PAYMENT_REMINDER_POLICY,
  parsePaymentPendingPolicy,
  resolveDuePaymentReminderTier,
} from "./paymentPendingReminderPolicy.js";

export const PAYMENT_PENDING_REMINDER_BODY =
  "Your booking payment is still pending. Please complete the payment to confirm your booking. A service provider cannot be assigned until the payment is successfully received.";

let cachedPolicy = null;
let cachedAt = 0;
const POLICY_CACHE_MS = 60_000;

export async function loadPaymentPendingPolicy() {
  const now = Date.now();
  if (cachedPolicy && now - cachedAt < POLICY_CACHE_MS) {
    return cachedPolicy;
  }

  const utilsUrl = (process.env.UTILS_SERVICE_URL || "http://localhost:3030").replace(
    /\/$/,
    ""
  );
  try {
    const res = await fetch(`${utilsUrl}/api/platform-settings`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      cachedPolicy = parsePaymentPendingPolicy(data?.settings ?? data);
      cachedAt = now;
      return cachedPolicy;
    }
  } catch {
    // fall through
  }

  cachedPolicy = { ...DEFAULT_PAYMENT_REMINDER_POLICY };
  cachedAt = now;
  return cachedPolicy;
}

async function getSentReminderTiers(customerId, engagementId) {
  const { rows } = await pool.query(
    `
    SELECT (metadata->>'reminder_tier_minutes')::int AS tier
    FROM in_app_notifications
    WHERE recipient_type = 'customer'
      AND recipient_id = $1
      AND engagement_id = $2
      AND type = $3
      AND metadata ? 'reminder_tier_minutes'
    `,
    [customerId, engagementId, InAppTypes.PAYMENT_PENDING_REMINDER]
  );
  return new Set(
    rows
      .map((r) => Number(r.tier))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
}

async function sendCustomerPushOptional(customerEmail, title, body) {
  const secret = (
    process.env.ADMIN_PUSH_SECRET ||
    process.env.INTERNAL_NOTIFY_SECRET ||
    ""
  ).trim();
  if (!secret || !customerEmail) {
    return { sent: false, reason: "push_not_configured" };
  }

  const utilsUrl = (process.env.UTILS_SERVICE_URL || "http://localhost:3030").replace(
    /\/$/,
    ""
  );
  try {
    const res = await fetch(`${utilsUrl}/api/push/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Push-Secret": secret,
      },
      body: JSON.stringify({
        title,
        body,
        target: "emails",
        emails: [String(customerEmail).trim().toLowerCase()],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { sent: false, reason: errBody || `push_http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("[payment-pending-reminder] push failed:", err?.message || err);
    return { sent: false, reason: err?.message || "push_failed" };
  }
}

export async function findPendingPaymentEngagements() {
  const { rows } = await pool.query(
    `
    SELECT
      e.engagement_id,
      e.customerid,
      e.booking_type,
      e.service_type,
      e.created_at,
      p.payment_id,
      p.total_amount,
      c.emailid AS customer_email,
      c.firstname AS customer_firstname
    FROM engagements e
    INNER JOIN payments p ON p.engagement_id = e.engagement_id
    INNER JOIN customer c ON c.customerid = e.customerid
    WHERE UPPER(COALESCE(p.status, '')) = 'PENDING'
      AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED')
      AND UPPER(COALESCE(e.engagement_status, '')) IN ('PAYMENT_PENDING', 'CREATED', '')
    ORDER BY e.created_at ASC
    `
  );
  return rows;
}

export async function dismissPaymentPendingRemindersForEngagement(engagementId) {
  const eid = Number(engagementId);
  if (!Number.isFinite(eid) || eid < 1) return { updated: 0 };
  const r = await pool.query(
    `
    UPDATE in_app_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE engagement_id = $1
      AND recipient_type = 'customer'
      AND type = $2
      AND read_at IS NULL
    `,
    [eid, InAppTypes.PAYMENT_PENDING_REMINDER]
  );
  return { updated: r.rowCount ?? 0 };
}

export async function processPaymentPendingReminders(ioOverride = null) {
  const policy = await loadPaymentPendingPolicy();
  const offsets = policy.paymentPendingOffsetsMinutes;
  const candidates = await findPendingPaymentEngagements();
  if (!candidates.length) return { processed: 0, notified: 0 };

  const io = ioOverride ?? getSocketServer();
  let notified = 0;

  for (const row of candidates) {
    const customerId = Number(row.customerid);
    const engagementId = Number(row.engagement_id);
    if (!Number.isFinite(customerId) || !Number.isFinite(engagementId)) continue;

    const createdAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
    if (!Number.isFinite(createdAt)) continue;

    const ageMinutes = (Date.now() - createdAt) / 60_000;
    const sentTiers = await getSentReminderTiers(customerId, engagementId);
    const dueTier = resolveDuePaymentReminderTier(ageMinutes, offsets, sentTiers);
    if (dueTier == null) continue;

    const title = "Payment pending";
    const body = PAYMENT_PENDING_REMINDER_BODY;

    try {
      await createInAppNotification({
        io,
        recipientType: "customer",
        recipientId: customerId,
        type: InAppTypes.PAYMENT_PENDING_REMINDER,
        title,
        body,
        engagementId,
        metadata: {
          action: "resume_payment",
          reminder_tier_minutes: dueTier,
          booking_type: row.booking_type,
          service_type: row.service_type,
          total_amount: row.total_amount != null ? Number(row.total_amount) : null,
        },
      });
    } catch (err) {
      console.error(
        `[payment-pending-reminder] in-app failed engagement=${engagementId}:`,
        err?.message || err
      );
      continue;
    }

    await sendCustomerPushOptional(row.customer_email, title, body);
    notified += 1;
  }

  return { processed: candidates.length, notified };
}

let schedulerStarted = false;

export function startPaymentPendingReminderScheduler(io = null) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = process.env.PAYMENT_PENDING_REMINDER_ENABLED !== "false";
  if (!enabled) {
    console.log(
      "[payment-pending-reminder] Scheduler disabled (PAYMENT_PENDING_REMINDER_ENABLED=false)"
    );
    return;
  }

  const tickMs = clampReminderInt(process.env.PAYMENT_PENDING_REMINDER_TICK_MS, 30_000, 300_000, 60_000);
  const startupDelayMs = clampReminderInt(
    process.env.PAYMENT_PENDING_REMINDER_STARTUP_DELAY_MS,
    5_000,
    120_000,
    45_000
  );

  const tick = async () => {
    try {
      const result = await processPaymentPendingReminders(io);
      if (result.notified > 0) {
        console.log(
          `[payment-pending-reminder] Sent ${result.notified} reminder(s) (${result.processed} pending booking(s) checked)`
        );
      }
    } catch (err) {
      console.error("[payment-pending-reminder] tick failed:", err?.message || err);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(tick, tickMs);
  }, startupDelayMs);

  console.log(
    `[payment-pending-reminder] Scheduler started (tick every ${tickMs / 1000}s, tiers from platform settings)`
  );
}
