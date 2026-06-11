import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { transitionEngagement } from "./engagementLifecycle.js";
import { refundRazorpayPaymentFull } from "./razorpayRefund.service.js";
import {
  createInAppNotification,
  dismissNewBookingInAppByEngagementId,
  InAppTypes,
} from "./inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import {
  isEligibleForOnDemandAutoCancel,
  ON_DEMAND_AUTO_CANCEL_EVENT,
  ON_DEMAND_AUTO_CANCEL_REASON,
} from "./onDemandUnassignedCancelPolicy.js";
import { buildBookingNotificationMetadata } from "./bookingNotificationMetadata.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export {
  ON_DEMAND_AUTO_CANCEL_REASON,
  ON_DEMAND_AUTO_CANCEL_EVENT,
  isEligibleForOnDemandAutoCancel,
} from "./onDemandUnassignedCancelPolicy.js";

const CUSTOMER_CANCEL_TITLE = "No provider was available";
const CUSTOMER_CANCEL_BODY =
  "We could not assign a service professional before your scheduled start time. " +
  "Your booking has been cancelled and a full refund is on its way to your original payment method " +
  "(typically within 5–7 business days).";

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
    console.error("[on-demand-auto-cancel] push failed:", err?.message || err);
    return { sent: false, reason: err?.message || "push_failed" };
  }
}

export async function findUnassignedOnDemandPastStart({ limit = 25, nowEpoch } = {}) {
  const now = Number.isFinite(Number(nowEpoch))
    ? Math.floor(Number(nowEpoch))
    : dayjs().tz("Asia/Kolkata").unix();
  const rowLimit = clampInt(limit, 1, 100, 25);

  const { rows } = await pool.query(
    `
    SELECT
      e.engagement_id,
      e.customerid,
      e.serviceproviderid,
      e.booking_type,
      e.assignment_status,
      e.engagement_status,
      e.task_status,
      e.start_epoch,
      e.service_type,
      p.payment_id,
      p.total_amount,
      p.transaction_id AS razorpay_payment_id,
      p.status AS payment_status,
      p.razorpay_order_id,
      c.emailid AS customer_email
    FROM engagements e
    INNER JOIN payments p ON p.engagement_id = e.engagement_id
    INNER JOIN customer c ON c.customerid = e.customerid
    WHERE UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
      AND e.serviceproviderid IS NULL
      AND UPPER(COALESCE(e.assignment_status, 'UNASSIGNED')) = 'UNASSIGNED'
      AND UPPER(COALESCE(e.engagement_status, '')) IN ('OPEN_FOR_ACCEPTANCE', 'UNASSIGNED', 'CRM_ESCALATED')
      AND UPPER(COALESCE(e.task_status, 'NOT_STARTED')) NOT IN ('CANCELLED', 'COMPLETED', 'IN_PROGRESS')
      AND e.start_epoch IS NOT NULL
      AND e.start_epoch <= $1
      AND UPPER(COALESCE(p.status, '')) = 'SUCCESS'
      AND NOT EXISTS (
        SELECT 1
        FROM engagement_events ev
        WHERE ev.engagement_id = e.engagement_id
          AND ev.event_type = $2
      )
    ORDER BY e.start_epoch ASC
    LIMIT $3
    `,
    [now, ON_DEMAND_AUTO_CANCEL_EVENT, rowLimit]
  );

  return rows;
}

export async function cancelUnassignedOnDemandBooking(row, { io = null } = {}) {
  const engagementId = Number(row.engagement_id);
  if (!Number.isFinite(engagementId) || engagementId < 1) {
    return { ok: false, reason: "invalid_engagement_id" };
  }

  const client = await pool.connect();
  let refundResult = null;
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
    const nowEpoch = dayjs().tz("Asia/Kolkata").unix();

    if (!isEligibleForOnDemandAutoCancel(engagement, payment, nowEpoch)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "no_longer_eligible" };
    }

    const razorpayPaymentId = payment.transaction_id;
    if (!razorpayPaymentId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "missing_razorpay_payment_id" };
    }

    refundResult = await refundRazorpayPaymentFull({
      razorpayPaymentId,
      amountInr: payment.total_amount,
      notes: {
        engagement_id: String(engagementId),
        reason: ON_DEMAND_AUTO_CANCEL_REASON,
      },
    });

    await client.query(
      `
      UPDATE payments
      SET status = 'REFUNDED',
          updated_at = NOW()
      WHERE payment_id = $1
      `,
      [payment.payment_id]
    );

    await transitionEngagement(client, {
      engagementId,
      newStatus: "CANCELLED",
      eventType: ON_DEMAND_AUTO_CANCEL_EVENT,
      actorType: "SYSTEM",
      actorId: null,
      metadata: {
        cancellation_reason: ON_DEMAND_AUTO_CANCEL_REASON,
        refund_amount_inr: Number(payment.total_amount),
        razorpay_payment_id: razorpayPaymentId,
        razorpay_refund_id: refundResult?.id ?? null,
        auto_cancelled: true,
      },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      `[on-demand-auto-cancel] failed engagement=${engagementId}:`,
      err?.message || err
    );
    return { ok: false, reason: err?.message || "cancel_failed", engagementId };
  } finally {
    client.release();
  }

  const socketServer = io != null ? io : getSocketServer();
  const customerId = Number(row.customerid);

  try {
    await dismissNewBookingInAppByEngagementId(engagementId);
  } catch (eDismiss) {
    console.error("[on-demand-auto-cancel] dismiss provider in-app failed", eDismiss);
  }

  const refundAmountInr =
    payment?.total_amount != null
      ? Number(payment.total_amount)
      : Number(row.total_amount);
  const notificationMetadata =
    engagement != null
      ? buildBookingNotificationMetadata(engagement, {
          total_amount: refundAmountInr,
          refund_amount_inr: refundAmountInr,
          cancellation_reason: ON_DEMAND_AUTO_CANCEL_REASON,
          razorpay_refund_id: refundResult?.id ?? null,
          auto_cancelled: true,
        })
      : {
          cancellation_reason: ON_DEMAND_AUTO_CANCEL_REASON,
          refund_amount_inr: refundAmountInr,
          razorpay_refund_id: refundResult?.id ?? null,
          auto_cancelled: true,
        };

  const bookingSummaryParts = [
    notificationMetadata.service_type,
    notificationMetadata.start_time_label,
    notificationMetadata.address,
    Number.isFinite(refundAmountInr) ? `Refund ₹${refundAmountInr}` : null,
  ].filter(Boolean);
  const pushBody =
    bookingSummaryParts.length > 0
      ? `${CUSTOMER_CANCEL_BODY}\n\n${bookingSummaryParts.join(" · ")}`
      : CUSTOMER_CANCEL_BODY;

  try {
    await createInAppNotification({
      io: socketServer,
      recipientType: "customer",
      recipientId: customerId,
      type: InAppTypes.BOOKING_AUTO_CANCELLED_NO_PROVIDER,
      title: CUSTOMER_CANCEL_TITLE,
      body: CUSTOMER_CANCEL_BODY,
      engagementId,
      metadata: notificationMetadata,
    });
  } catch (eNotif) {
    console.error("[on-demand-auto-cancel] customer in-app failed", eNotif);
  }

  if (socketServer && Number.isFinite(customerId)) {
    socketServer.to(`customer_${customerId}`).emit("engagement-cancelled", {
      engagement_id: engagementId,
      booking_type: "ON_DEMAND",
      cancellation_reason: ON_DEMAND_AUTO_CANCEL_REASON,
      refund_amount: refundAmountInr,
      refunded: true,
      ...notificationMetadata,
    });
  }

  await sendCustomerPushOptional(row.customer_email, CUSTOMER_CANCEL_TITLE, pushBody);

  return {
    ok: true,
    engagementId,
    refundId: refundResult?.id ?? null,
  };
}

export async function processUnassignedOnDemandAutoCancels({ io = null, limit = 25 } = {}) {
  const candidates = await findUnassignedOnDemandPastStart({ limit });
  let cancelled = 0;
  const results = [];

  for (const row of candidates) {
    /* eslint-disable no-await-in-loop */
    const result = await cancelUnassignedOnDemandBooking(row, { io });
    /* eslint-enable no-await-in-loop */
    results.push(result);
    if (result.ok) cancelled += 1;
  }

  return { processed: candidates.length, cancelled, results };
}

let schedulerStarted = false;

export function startOnDemandUnassignedCancelScheduler(io = null) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = process.env.ON_DEMAND_AUTO_CANCEL_ENABLED !== "false";
  if (!enabled) {
    console.log(
      "[on-demand-auto-cancel] Scheduler disabled (ON_DEMAND_AUTO_CANCEL_ENABLED=false)"
    );
    return;
  }

  const tickMs = clampInt(process.env.ON_DEMAND_AUTO_CANCEL_TICK_MS, 30_000, 600_000, 60_000);
  const startupDelayMs = clampInt(
    process.env.ON_DEMAND_AUTO_CANCEL_STARTUP_DELAY_MS,
    5_000,
    120_000,
    45_000
  );

  const tick = async () => {
    try {
      const result = await processUnassignedOnDemandAutoCancels({ io });
      if (result.cancelled > 0) {
        console.log(
          `[on-demand-auto-cancel] Cancelled ${result.cancelled} booking(s) with refund (${result.processed} candidate(s) checked)`
        );
      }
    } catch (err) {
      console.error("[on-demand-auto-cancel] tick failed:", err?.message || err);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(tick, tickMs);
  }, startupDelayMs);

  console.log(
    `[on-demand-auto-cancel] Scheduler started (tick every ${tickMs / 1000}s)`
  );
}
