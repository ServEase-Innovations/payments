import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { transitionEngagement } from "./engagementLifecycle.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import {
  ON_DEMAND_CRM_ESCALATION_EVENT,
  getOnDemandAcceptanceWindowMinutes,
  getOnDemandCrmEscalationMinutesBeforeStart,
  isEligibleForOnDemandCrmEscalation,
  resolveOnDemandCrmEscalationReason,
} from "./onDemandWorkflowPolicy.js";
import { broadcastOnDemandToProviders } from "./onDemandProviderBroadcast.js";
import {
  upsertProviderNewBookingNotification,
  dismissNewBookingInAppByEngagementId,
} from "./inAppNotification.service.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function notifyOnDemandProviderForEscalation(socketServer, engagement, providerRow, distanceM) {
  const spid = Number(providerRow.serviceproviderid);
  if (!Number.isFinite(spid) || spid < 1) return false;

  const room = `provider_${spid}`;
  const distanceKm = Math.round((distanceM / 1000) * 10) / 10;
  const startTimeLabel = engagement.start_epoch
    ? dayjs.unix(Number(engagement.start_epoch)).tz("Asia/Kolkata").format("D MMM YYYY, h:mm a")
    : "";

  socketServer?.to(room).emit("new-engagement-request", {
    engagement_id: engagement.engagement_id,
    service_type: engagement.service_type,
    booking_type: engagement.booking_type,
    start_date: engagement.start_date,
    start_epoch: engagement.start_epoch,
    duration_minutes: engagement.duration_minutes,
    base_amount: engagement.base_amount,
    address: engagement.address || null,
    distance_meters: distanceM,
    payment_ready: true,
    crm_escalated: true,
  });

  try {
    await upsertProviderNewBookingNotification({
      io: socketServer,
      recipientId: spid,
      engagementId: engagement.engagement_id,
      title: "Urgent: on-demand booking needs a provider",
      body: [
        engagement.service_type,
        startTimeLabel ? `Starts ${startTimeLabel}` : null,
        `~${distanceKm} km from you`,
        "Ops team is assisting — tap to accept if available",
      ]
        .filter(Boolean)
        .join(" · "),
      metadata: {
        service_type: engagement.service_type,
        booking_type: engagement.booking_type,
        start_epoch: engagement.start_epoch,
        start_time_label: startTimeLabel,
        distance_km: distanceKm,
        crm_escalated: true,
        payment_ready: true,
      },
    });
  } catch (err) {
    console.error("[on-demand-crm] provider in-app failed", err);
    return false;
  }

  return true;
}

function emitAdminCrmEscalation(io, payload) {
  if (!io) return;
  io.to("admins").emit("on_demand_crm_escalation", payload);
}

export async function findOnDemandBookingsForCrmEscalation({ limit = 25 } = {}) {
  const windowMinutes = getOnDemandAcceptanceWindowMinutes();
  const startLeadMinutes = getOnDemandCrmEscalationMinutesBeforeStart();
  const rowLimit = clampInt(limit, 1, 100, 25);

  const { rows } = await pool.query(
    `
    SELECT
      e.*,
      p.payment_id,
      p.status AS payment_status,
      pay_evt.created_at AS payment_completed_at,
      c.firstname AS customer_firstname,
      c.lastname AS customer_lastname,
      c.mobileno AS customer_mobile,
      c.emailid AS customer_email
    FROM engagements e
    INNER JOIN payments p ON p.engagement_id = e.engagement_id
    INNER JOIN customer c ON c.customerid = e.customerid
    INNER JOIN LATERAL (
      SELECT ev.created_at
      FROM engagement_events ev
      WHERE ev.engagement_id = e.engagement_id
        AND ev.event_type = 'PAYMENT_COMPLETED'
      ORDER BY ev.created_at DESC
      LIMIT 1
    ) pay_evt ON true
    WHERE UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
      AND e.serviceproviderid IS NULL
      AND UPPER(COALESCE(e.assignment_status, 'UNASSIGNED')) = 'UNASSIGNED'
      AND UPPER(COALESCE(e.engagement_status, '')) IN ('OPEN_FOR_ACCEPTANCE', 'UNASSIGNED')
      AND UPPER(COALESCE(e.task_status, 'NOT_STARTED')) NOT IN ('CANCELLED', 'COMPLETED', 'IN_PROGRESS')
      AND UPPER(COALESCE(p.status, '')) = 'SUCCESS'
      AND e.start_epoch IS NOT NULL
      AND e.start_epoch > EXTRACT(EPOCH FROM NOW())::bigint
      AND (
        pay_evt.created_at <= NOW() - ($1::int * interval '1 minute')
        OR e.start_epoch <= EXTRACT(EPOCH FROM NOW())::bigint + ($4::int * 60)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM engagement_events ev2
        WHERE ev2.engagement_id = e.engagement_id
          AND ev2.event_type = $2
      )
    ORDER BY e.start_epoch ASC
    LIMIT $3
    `,
    [windowMinutes, ON_DEMAND_CRM_ESCALATION_EVENT, rowLimit, startLeadMinutes]
  );

  return rows;
}

export async function escalateOnDemandBookingToCrm(row, { io = null } = {}) {
  const engagementId = Number(row.engagement_id);
  if (!Number.isFinite(engagementId) || engagementId < 1) {
    return { ok: false, reason: "invalid_engagement_id" };
  }

  const nowEpoch = dayjs().tz("Asia/Kolkata").unix();
  if (
    !isEligibleForOnDemandCrmEscalation(
      row,
      { status: row.payment_status },
      row.payment_completed_at,
      nowEpoch
    )
  ) {
    return { ok: false, reason: "no_longer_eligible" };
  }

  const client = await pool.connect();
  let engagement = null;

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

    engagement = engRes.rows[0];
    if (
      !isEligibleForOnDemandCrmEscalation(
        engagement,
        { status: row.payment_status },
        row.payment_completed_at,
        nowEpoch
      )
    ) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "no_longer_eligible" };
    }

    const escalationReason = resolveOnDemandCrmEscalationReason(
      engagement,
      row.payment_completed_at,
      nowEpoch
    );

    await transitionEngagement(client, {
      engagementId,
      newStatus: "CRM_ESCALATED",
      eventType: ON_DEMAND_CRM_ESCALATION_EVENT,
      actorType: "SYSTEM",
      actorId: null,
      metadata: {
        escalation_reason: escalationReason,
        acceptance_window_minutes: getOnDemandAcceptanceWindowMinutes(),
        crm_escalation_minutes_before_start: getOnDemandCrmEscalationMinutesBeforeStart(),
        payment_completed_at: row.payment_completed_at,
        escalated_at: new Date().toISOString(),
      },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      `[on-demand-crm] escalation failed engagement=${engagementId}:`,
      err?.message || err
    );
    return { ok: false, reason: err?.message || "escalation_failed", engagementId };
  } finally {
    client.release();
  }

  const socketServer = io != null ? io : getSocketServer();
  const startTimeLabel = engagement?.start_epoch
    ? dayjs.unix(Number(engagement.start_epoch)).tz("Asia/Kolkata").format("D MMM YYYY, h:mm a")
    : "";

  const adminPayload = {
    engagementId,
    bookingType: "ON_DEMAND",
    serviceType: engagement?.service_type,
    startEpoch: engagement?.start_epoch,
    startTimeLabel,
    address: engagement?.address || null,
    customerId: Number(row.customerid),
    customerName: [row.customer_firstname, row.customer_lastname].filter(Boolean).join(" ").trim(),
    customerMobile: row.customer_mobile || null,
    customerEmail: row.customer_email || null,
    escalatedAt: new Date().toISOString(),
  };

  emitAdminCrmEscalation(socketServer, adminPayload);

  try {
    await dismissNewBookingInAppByEngagementId(engagementId);
  } catch (eDismiss) {
    console.error("[on-demand-crm] dismiss stale provider rows failed", eDismiss);
  }

  let rebroadcastCount = 0;
  if (engagement?.latitude && engagement?.longitude) {
    rebroadcastCount = await broadcastOnDemandToProviders({
      engagement,
      notifyProvider: (providerRow, distance) =>
        notifyOnDemandProviderForEscalation(socketServer, engagement, providerRow, distance),
    });
  }

  return {
    ok: true,
    engagementId,
    rebroadcastCount,
  };
}

export async function processOnDemandCrmEscalations({ io = null, limit = 25 } = {}) {
  const candidates = await findOnDemandBookingsForCrmEscalation({ limit });
  let escalated = 0;
  const results = [];

  for (const row of candidates) {
    /* eslint-disable no-await-in-loop */
    const result = await escalateOnDemandBookingToCrm(row, { io });
    /* eslint-enable no-await-in-loop */
    results.push(result);
    if (result.ok) escalated += 1;
  }

  return { processed: candidates.length, escalated, results };
}

let schedulerStarted = false;

export function startOnDemandCrmEscalationScheduler(io = null) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = process.env.ON_DEMAND_CRM_ESCALATION_ENABLED !== "false";
  if (!enabled) {
    console.log(
      "[on-demand-crm] Scheduler disabled (ON_DEMAND_CRM_ESCALATION_ENABLED=false)"
    );
    return;
  }

  const tickMs = clampInt(process.env.ON_DEMAND_CRM_ESCALATION_TICK_MS, 30_000, 600_000, 60_000);
  const startupDelayMs = clampInt(
    process.env.ON_DEMAND_CRM_ESCALATION_STARTUP_DELAY_MS,
    5_000,
    120_000,
    30_000
  );

  const tick = async () => {
    try {
      const result = await processOnDemandCrmEscalations({ io });
      if (result.escalated > 0) {
        console.log(
          `[on-demand-crm] Escalated ${result.escalated} booking(s) to CRM (${result.processed} candidate(s) checked)`
        );
      }
    } catch (err) {
      console.error("[on-demand-crm] tick failed:", err?.message || err);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(tick, tickMs);
  }, startupDelayMs);

  console.log(`[on-demand-crm] Scheduler started (tick every ${tickMs / 1000}s)`);
}
