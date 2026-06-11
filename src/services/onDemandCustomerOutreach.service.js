import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { transitionEngagement } from "./engagementLifecycle.js";
import {
  createInAppNotification,
  InAppTypes,
} from "./inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import { buildBookingNotificationMetadata } from "./bookingNotificationMetadata.js";
import {
  ON_DEMAND_CUSTOMER_OUTREACH_EVENT,
  getOnDemandCustomerOutreachMinutesBeforeStart,
  isEligibleForOnDemandCustomerOutreach,
} from "./onDemandWorkflowPolicy.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const OUTREACH_TITLE = "We're still finding your service professional";
const OUTREACH_BODY =
  "Our operations team is actively contacting nearby providers for your on-demand booking. " +
  "If we cannot assign someone before your scheduled start time, we will contact you with options " +
  "and process a full refund if no provider is available.";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
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
    console.error("[on-demand-outreach] push failed:", err?.message || err);
    return { sent: false, reason: err?.message || "push_failed" };
  }
}

export async function findOnDemandBookingsForCustomerOutreach({ limit = 25 } = {}) {
  const leadMinutes = getOnDemandCustomerOutreachMinutesBeforeStart();
  const rowLimit = clampInt(limit, 1, 100, 25);
  const nowEpoch = dayjs().tz("Asia/Kolkata").unix();
  const outreachThreshold = nowEpoch + leadMinutes * 60;

  const { rows } = await pool.query(
    `
    SELECT
      e.*,
      p.status AS payment_status,
      c.emailid AS customer_email
    FROM engagements e
    INNER JOIN payments p ON p.engagement_id = e.engagement_id
    INNER JOIN customer c ON c.customerid = e.customerid
    WHERE UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
      AND e.serviceproviderid IS NULL
      AND UPPER(COALESCE(e.assignment_status, 'UNASSIGNED')) = 'UNASSIGNED'
      AND UPPER(COALESCE(e.engagement_status, '')) = 'CRM_ESCALATED'
      AND UPPER(COALESCE(e.task_status, 'NOT_STARTED')) NOT IN ('CANCELLED', 'COMPLETED', 'IN_PROGRESS')
      AND UPPER(COALESCE(p.status, '')) = 'SUCCESS'
      AND e.start_epoch IS NOT NULL
      AND e.start_epoch > $1
      AND e.start_epoch <= $2
      AND EXISTS (
        SELECT 1
        FROM engagement_events ev
        WHERE ev.engagement_id = e.engagement_id
          AND ev.event_type = 'ON_DEMAND_CRM_ESCALATED'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM engagement_events ev2
        WHERE ev2.engagement_id = e.engagement_id
          AND ev2.event_type = $3
      )
    ORDER BY e.start_epoch ASC
    LIMIT $4
    `,
    [nowEpoch, outreachThreshold, ON_DEMAND_CUSTOMER_OUTREACH_EVENT, rowLimit]
  );

  return rows;
}

export async function sendOnDemandCustomerOutreach(row, { io = null } = {}) {
  const engagementId = Number(row.engagement_id);
  if (!Number.isFinite(engagementId) || engagementId < 1) {
    return { ok: false, reason: "invalid_engagement_id" };
  }

  const nowEpoch = dayjs().tz("Asia/Kolkata").unix();
  if (
    !isEligibleForOnDemandCustomerOutreach(
      row,
      { status: row.payment_status },
      nowEpoch,
      { crmEscalated: true }
    )
  ) {
    return { ok: false, reason: "no_longer_eligible" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dup = await client.query(
      `
      SELECT 1
      FROM engagement_events
      WHERE engagement_id = $1 AND event_type = $2
      LIMIT 1
      `,
      [engagementId, ON_DEMAND_CUSTOMER_OUTREACH_EVENT]
    );
    if (dup.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_sent" };
    }

    await transitionEngagement(client, {
      engagementId,
      newStatus: "CRM_ESCALATED",
      eventType: ON_DEMAND_CUSTOMER_OUTREACH_EVENT,
      actorType: "SYSTEM",
      actorId: null,
      metadata: {
        outreach_minutes_before_start: getOnDemandCustomerOutreachMinutesBeforeStart(),
        sent_at: new Date().toISOString(),
      },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      `[on-demand-outreach] failed engagement=${engagementId}:`,
      err?.message || err
    );
    return { ok: false, reason: err?.message || "outreach_failed", engagementId };
  } finally {
    client.release();
  }

  const socketServer = io != null ? io : getSocketServer();
  const customerId = Number(row.customerid);
  const metadata = buildBookingNotificationMetadata(row, {
    crm_escalated: true,
    outreach: true,
  });

  try {
    await createInAppNotification({
      io: socketServer,
      recipientType: "customer",
      recipientId: customerId,
      type: InAppTypes.ON_DEMAND_ASSIGNMENT_PENDING,
      title: OUTREACH_TITLE,
      body: OUTREACH_BODY,
      engagementId,
      metadata,
    });
  } catch (err) {
    console.error("[on-demand-outreach] customer in-app failed", err);
  }

  if (socketServer && Number.isFinite(customerId)) {
    socketServer.to(`customer_${customerId}`).emit("on-demand-assignment-pending", {
      engagement_id: engagementId,
      ...metadata,
    });
  }

  await sendCustomerPushOptional(row.customer_email, OUTREACH_TITLE, OUTREACH_BODY);

  return { ok: true, engagementId };
}

export async function processOnDemandCustomerOutreach({ io = null, limit = 25 } = {}) {
  const candidates = await findOnDemandBookingsForCustomerOutreach({ limit });
  let sent = 0;
  const results = [];

  for (const row of candidates) {
    /* eslint-disable no-await-in-loop */
    const result = await sendOnDemandCustomerOutreach(row, { io });
    /* eslint-enable no-await-in-loop */
    results.push(result);
    if (result.ok) sent += 1;
  }

  return { processed: candidates.length, sent, results };
}

let schedulerStarted = false;

export function startOnDemandCustomerOutreachScheduler(io = null) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = process.env.ON_DEMAND_CUSTOMER_OUTREACH_ENABLED !== "false";
  if (!enabled) {
    console.log(
      "[on-demand-outreach] Scheduler disabled (ON_DEMAND_CUSTOMER_OUTREACH_ENABLED=false)"
    );
    return;
  }

  const tickMs = clampInt(
    process.env.ON_DEMAND_CUSTOMER_OUTREACH_TICK_MS,
    30_000,
    600_000,
    60_000
  );
  const startupDelayMs = clampInt(
    process.env.ON_DEMAND_CUSTOMER_OUTREACH_STARTUP_DELAY_MS,
    5_000,
    120_000,
    45_000
  );

  const tick = async () => {
    try {
      const result = await processOnDemandCustomerOutreach({ io });
      if (result.sent > 0) {
        console.log(
          `[on-demand-outreach] Notified ${result.sent} customer(s) (${result.processed} candidate(s) checked)`
        );
      }
    } catch (err) {
      console.error("[on-demand-outreach] tick failed:", err?.message || err);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(tick, tickMs);
  }, startupDelayMs);

  console.log(`[on-demand-outreach] Scheduler started (tick every ${tickMs / 1000}s)`);
}
