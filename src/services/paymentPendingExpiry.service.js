import pool from "../config/db.js";
import { transitionEngagement } from "./engagementLifecycle.js";
import {
  createInAppNotification,
  InAppTypes,
} from "./inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import {
  clampReminderInt,
  isEligibleForPaymentTimeoutExpiry,
} from "./paymentPendingReminderPolicy.js";
import {
  dismissPaymentPendingRemindersForEngagement,
  loadPaymentPendingPolicy,
} from "./paymentPendingReminder.service.js";
import { buildBookingNotificationMetadata } from "./bookingNotificationMetadata.js";

export const PAYMENT_TIMEOUT_EVENT = "PAYMENT_TIMEOUT";
export const PAYMENT_TIMEOUT_REASON = "Payment Timeout";

const CUSTOMER_CANCEL_TITLE = "Booking cancelled — payment not received";
function customerCancelBody(expiryMinutes) {
  const mins = Number(expiryMinutes);
  const label = Number.isFinite(mins) && mins > 0 ? `${mins} minutes` : "20 minutes";
  return (
    `Your booking was automatically cancelled because payment was not completed within ${label}. ` +
    "You can place a new booking anytime."
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
    console.error("[payment-pending-expiry] push failed:", err?.message || err);
    return { sent: false, reason: err?.message || "push_failed" };
  }
}

export async function findExpiredPendingPaymentEngagements({ expiryMinutes, limit = 50 } = {}) {
  const expiry = clampReminderInt(expiryMinutes, 5, 7 * 24 * 60, 20);
  const rowLimit = clampReminderInt(limit, 1, 200, 50);

  const { rows } = await pool.query(
    `
    SELECT
      e.engagement_id,
      e.customerid,
      e.serviceproviderid,
      e.booking_type,
      e.engagement_status,
      e.task_status,
      e.service_type,
      e.created_at,
      p.payment_id,
      p.status AS payment_status,
      p.total_amount,
      c.emailid AS customer_email
    FROM engagements e
    INNER JOIN payments p ON p.engagement_id = e.engagement_id
    INNER JOIN customer c ON c.customerid = e.customerid
    WHERE UPPER(COALESCE(p.status, '')) = 'PENDING'
      AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED')
      AND UPPER(COALESCE(e.engagement_status, '')) IN ('PAYMENT_PENDING', 'CREATED', '')
      AND e.created_at <= NOW() - ($1::int * interval '1 minute')
      AND NOT EXISTS (
        SELECT 1
        FROM engagement_events ev
        WHERE ev.engagement_id = e.engagement_id
          AND ev.event_type = $2
      )
    ORDER BY e.created_at ASC
    LIMIT $3
    `,
    [expiry, PAYMENT_TIMEOUT_EVENT, rowLimit]
  );

  return rows;
}

export async function cancelExpiredPendingPaymentBooking(row, { expiryMinutes, io = null } = {}) {
  const engagementId = Number(row.engagement_id);
  if (!Number.isFinite(engagementId) || engagementId < 1) {
    return { ok: false, reason: "invalid_engagement_id" };
  }

  const client = await pool.connect();
  let engagement = null;
  let payment = null;

  try {
    await client.query("BEGIN");

    const engRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id = $1 FOR UPDATE`,
      [engagementId]
    );
    if (!engRes.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "engagement_not_found" };
    }

    const payRes = await client.query(
      `SELECT * FROM payments WHERE engagement_id = $1 FOR UPDATE`,
      [engagementId]
    );
    if (!payRes.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "payment_not_found" };
    }

    engagement = engRes.rows[0];
    payment = payRes.rows[0];

    const createdAt = engagement.created_at
      ? new Date(engagement.created_at).getTime()
      : NaN;
    const ageMinutes = Number.isFinite(createdAt)
      ? (Date.now() - createdAt) / 60_000
      : NaN;

    if (!isEligibleForPaymentTimeoutExpiry(engagement, payment, ageMinutes, expiryMinutes)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "no_longer_eligible" };
    }

    await client.query(
      `
      UPDATE payments
      SET status = 'FAILED',
          updated_at = NOW()
      WHERE payment_id = $1
      `,
      [payment.payment_id]
    );

    await transitionEngagement(client, {
      engagementId,
      newStatus: "CANCELLED",
      eventType: PAYMENT_TIMEOUT_EVENT,
      actorType: "SYSTEM",
      actorId: null,
      metadata: {
        cancellation_reason: PAYMENT_TIMEOUT_REASON,
        payment_timeout_minutes: Number(expiryMinutes),
        auto_cancelled: true,
      },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      `[payment-pending-expiry] failed engagement=${engagementId}:`,
      err?.message || err
    );
    return { ok: false, reason: err?.message || "cancel_failed", engagementId };
  } finally {
    client.release();
  }

  const socketServer = io != null ? io : getSocketServer();
  const customerId = Number(row.customerid);

  try {
    await dismissPaymentPendingRemindersForEngagement(engagementId);
  } catch (eDismiss) {
    console.error("[payment-pending-expiry] dismiss payment reminders failed", eDismiss);
  }

  const notificationMetadata = buildBookingNotificationMetadata(engagement, {
    cancellation_reason: PAYMENT_TIMEOUT_REASON,
    payment_timeout_minutes: Number(expiryMinutes),
    auto_cancelled: true,
    total_amount: payment?.total_amount != null ? Number(payment.total_amount) : null,
  });

  const cancelBody = customerCancelBody(expiryMinutes);
  const bodyWithContext =
    notificationMetadata.service_type || notificationMetadata.start_time_label
      ? `${cancelBody}\n\n${[
          notificationMetadata.service_type,
          notificationMetadata.start_time_label,
        ]
          .filter(Boolean)
          .join(" · ")}`
      : cancelBody;

  try {
    await createInAppNotification({
      io: socketServer,
      recipientType: "customer",
      recipientId: customerId,
      type: InAppTypes.BOOKING_AUTO_CANCELLED_PAYMENT_TIMEOUT,
      title: CUSTOMER_CANCEL_TITLE,
      body: cancelBody,
      engagementId,
      metadata: notificationMetadata,
    });
  } catch (eNotif) {
    console.error("[payment-pending-expiry] customer in-app failed", eNotif);
  }

  if (socketServer && Number.isFinite(customerId)) {
    socketServer.to(`customer_${customerId}`).emit("engagement-cancelled", {
      engagement_id: engagementId,
      booking_type: engagement?.booking_type ?? row.booking_type,
      cancellation_reason: PAYMENT_TIMEOUT_REASON,
      payment_timeout: true,
      refunded: false,
      ...notificationMetadata,
    });
  }

  await sendCustomerPushOptional(row.customer_email, CUSTOMER_CANCEL_TITLE, bodyWithContext);

  return { ok: true, engagementId };
}

export async function processPaymentPendingExpiries({ io = null, limit = 50 } = {}) {
  const policy = await loadPaymentPendingPolicy();
  const expiryMinutes = policy.paymentPendingExpiryMinutes;
  const candidates = await findExpiredPendingPaymentEngagements({
    expiryMinutes,
    limit,
  });

  let cancelled = 0;
  const results = [];

  for (const row of candidates) {
    /* eslint-disable no-await-in-loop */
    const result = await cancelExpiredPendingPaymentBooking(row, {
      expiryMinutes,
      io,
    });
    /* eslint-enable no-await-in-loop */
    results.push(result);
    if (result.ok) cancelled += 1;
  }

  return { processed: candidates.length, cancelled, expiryMinutes, results };
}

let schedulerStarted = false;

export function startPaymentPendingExpiryScheduler(io = null) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = process.env.PAYMENT_PENDING_EXPIRY_ENABLED !== "false";
  if (!enabled) {
    console.log(
      "[payment-pending-expiry] Scheduler disabled (PAYMENT_PENDING_EXPIRY_ENABLED=false)"
    );
    return;
  }

  const tickMs = clampReminderInt(process.env.PAYMENT_PENDING_EXPIRY_TICK_MS, 30_000, 300_000, 60_000);
  const startupDelayMs = clampReminderInt(
    process.env.PAYMENT_PENDING_EXPIRY_STARTUP_DELAY_MS,
    5_000,
    120_000,
    50_000
  );

  const tick = async () => {
    try {
      const result = await processPaymentPendingExpiries({ io });
      if (result.cancelled > 0) {
        console.log(
          `[payment-pending-expiry] Auto-cancelled ${result.cancelled} unpaid booking(s) after ${result.expiryMinutes}m (${result.processed} candidate(s) checked)`
        );
      }
    } catch (err) {
      console.error("[payment-pending-expiry] tick failed:", err?.message || err);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(tick, tickMs);
  }, startupDelayMs);

  console.log(
    `[payment-pending-expiry] Scheduler started (tick every ${tickMs / 1000}s)`
  );
}
