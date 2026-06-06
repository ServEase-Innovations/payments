import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import pool from "../config/db.js";
import { PG_IST_TODAY_DATE } from "../config/istDateSql.js";
import { repairTodayServiceDays } from "../routes/serviceDays.service.js";
import {
  createInAppNotification,
  InAppTypes,
} from "./inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import twilio from "twilio";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

export const DEFAULT_REMINDER_POLICY = {
  overdueStartIntervalMinutes: 15,
};

let cachedPolicy = null;
let cachedAt = 0;
const POLICY_CACHE_MS = 60_000;

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function parseReminderPolicy(settings) {
  const raw = settings?.providerReminders;
  return {
    overdueStartIntervalMinutes: clampInt(
      raw?.overdueStartIntervalMinutes,
      5,
      180,
      DEFAULT_REMINDER_POLICY.overdueStartIntervalMinutes
    ),
  };
}

export async function loadReminderPolicy() {
  const now = Date.now();
  if (cachedPolicy && now - cachedAt < POLICY_CACHE_MS) {
    return cachedPolicy;
  }

  const utilsUrl = (process.env.UTILS_SERVICE_URL || "http://localhost:3030").replace(/\/$/, "");
  try {
    const res = await fetch(`${utilsUrl}/api/platform-settings`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      cachedPolicy = parseReminderPolicy(data?.settings ?? data);
      cachedAt = now;
      return cachedPolicy;
    }
  } catch {
    // fall through
  }

  cachedPolicy = { ...DEFAULT_REMINDER_POLICY };
  cachedAt = now;
  return cachedPolicy;
}

export function isVisitOverdue({
  scheduledStartEpoch,
  serviceDayStatus,
  nowUnix = dayjs().unix(),
}) {
  const sd = String(serviceDayStatus ?? "").toUpperCase();
  if (["IN_PROGRESS", "STARTED", "COMPLETED", "DONE", "SKIPPED"].includes(sd)) {
    return false;
  }
  const start = Number(scheduledStartEpoch);
  if (!Number.isFinite(start) || start <= 0) return false;
  return nowUnix >= start;
}

function formatStartLabel(epoch) {
  return dayjs.unix(Number(epoch)).tz("Asia/Kolkata").format("h:mm A");
}

function buildReminderMessage(engagementId, scheduledStartEpoch) {
  const startLabel = formatStartLabel(scheduledStartEpoch);
  return `Your booking #${engagementId} was scheduled to start at ${startLabel} and has not been started yet. Please start the task or update the booking status.`;
}

async function wasReminderSentRecently({
  providerId,
  engagementId,
  serviceDayId,
  intervalMinutes,
}) {
  const { rows } = await pool.query(
    `
    SELECT 1
    FROM in_app_notifications
    WHERE recipient_type = 'provider'
      AND recipient_id = $1
      AND engagement_id = $2
      AND type = $3
      AND (
        $4::bigint IS NULL
        OR (metadata->>'service_day_id')::bigint = $4
      )
      AND created_at > NOW() - ($5::int * INTERVAL '1 minute')
    LIMIT 1
    `,
    [
      providerId,
      engagementId,
      InAppTypes.SERVICE_START_OVERDUE,
      serviceDayId,
      intervalMinutes,
    ]
  );
  return rows.length > 0;
}

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function formatE164Indian(mobile) {
  if (mobile == null || String(mobile).trim() === "") return null;
  const digits = String(mobile).replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return null;
}

async function sendReminderSmsOptional(mobile, message) {
  const client = getTwilioClient();
  if (!client) return { sent: false, reason: "sms_not_configured" };
  const to = formatE164Indian(mobile);
  if (!to) return { sent: false, reason: "invalid_mobile" };
  try {
    await client.messages.create({
      body: message.slice(0, 320),
      from: process.env.TWILIO_FROM_NUMBER || "+15803243872",
      to,
    });
    return { sent: true };
  } catch (err) {
    console.error("[overdue-reminder] SMS failed:", err?.message || err);
    return { sent: false, reason: err?.message || "sms_failed" };
  }
}

async function sendReminderPushOptional(providerEmail, title, body, engagementId) {
  const secret = (
    process.env.ADMIN_PUSH_SECRET ||
    process.env.INTERNAL_NOTIFY_SECRET ||
    ""
  ).trim();
  if (!secret || !providerEmail) {
    return { sent: false, reason: "push_not_configured" };
  }

  const utilsUrl = (process.env.UTILS_SERVICE_URL || "http://localhost:3030").replace(/\/$/, "");
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
        emails: [String(providerEmail).trim().toLowerCase()],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { sent: false, reason: errBody || `push_http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("[overdue-reminder] push failed:", err?.message || err);
    return { sent: false, reason: err?.message || "push_failed" };
  }
}

export async function findOverdueVisits() {
  const activeEngagements = await pool.query(
    `
    SELECT DISTINCT e.engagement_id
    FROM engagements e
    LEFT JOIN provider_availability pa
      ON pa.engagement_id = e.engagement_id
      AND pa.date = ${PG_IST_TODAY_DATE}
      AND pa.status = 'BOOKED'
    WHERE e.serviceproviderid IS NOT NULL
      AND UPPER(COALESCE(e.assignment_status, '')) = 'ASSIGNED'
      AND UPPER(COALESCE(e.engagement_status, '')) NOT IN ('CANCELLED', 'COMPLETED', 'CLOSED')
      AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED', 'COMPLETED')
      AND (
        pa.id IS NOT NULL
        OR (
          e.start_date <= ${PG_IST_TODAY_DATE}
          AND COALESCE(e.end_date, e.start_date) >= ${PG_IST_TODAY_DATE}
        )
      )
    `
  );

  const engIds = activeEngagements.rows.map((r) => r.engagement_id);
  if (engIds.length > 0) {
    await repairTodayServiceDays(pool, engIds);
  }

  const { rows } = await pool.query(
    `
    WITH today_ist AS (
      SELECT
        ${PG_IST_TODAY_DATE} AS d,
        EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::bigint AS now_epoch
    ),
    visit_rows AS (
      SELECT
        e.engagement_id,
        e.serviceproviderid,
        e.booking_type,
        e.service_type,
        e.start_epoch,
        COALESCE(pa.slot_start_epoch, e.start_epoch) AS scheduled_start_epoch,
        sd.service_day_id,
        COALESCE(sd.status, 'SCHEDULED') AS service_day_status,
        sp.emailid AS provider_email,
        sp.mobileno AS provider_mobile,
        c.firstname AS customer_firstname,
        c.lastname AS customer_lastname
      FROM engagements e
      JOIN serviceprovider sp ON sp.serviceproviderid = e.serviceproviderid
      JOIN customer c ON c.customerid = e.customerid
      CROSS JOIN today_ist t
      LEFT JOIN provider_availability pa
        ON pa.engagement_id = e.engagement_id
        AND pa.serviceproviderid = e.serviceproviderid
        AND pa.date = t.d
        AND pa.status = 'BOOKED'
      LEFT JOIN service_days sd
        ON sd.engagement_id = e.engagement_id
        AND sd.service_date = t.d
      WHERE e.serviceproviderid IS NOT NULL
        AND UPPER(COALESCE(e.assignment_status, '')) = 'ASSIGNED'
        AND UPPER(COALESCE(e.engagement_status, '')) NOT IN ('CANCELLED', 'COMPLETED', 'CLOSED')
        AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED', 'COMPLETED')
        AND (
          pa.id IS NOT NULL
          OR (
            e.start_date <= t.d
            AND COALESCE(e.end_date, e.start_date) >= t.d
          )
        )
    )
    SELECT *
    FROM visit_rows v
    CROSS JOIN today_ist t
    WHERE UPPER(COALESCE(v.service_day_status, 'SCHEDULED')) IN ('SCHEDULED', 'PENDING', '')
      AND v.scheduled_start_epoch IS NOT NULL
      AND v.scheduled_start_epoch <= t.now_epoch
    ORDER BY v.scheduled_start_epoch ASC
    `
  );

  return rows;
}

export async function dismissOverdueRemindersForEngagement(engagementId) {
  const eid = Number(engagementId);
  if (!Number.isFinite(eid) || eid < 1) return { updated: 0 };
  const r = await pool.query(
    `
    UPDATE in_app_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE engagement_id = $1
      AND recipient_type = 'provider'
      AND type = $2
      AND read_at IS NULL
    `,
    [eid, InAppTypes.SERVICE_START_OVERDUE]
  );
  return { updated: r.rowCount ?? 0 };
}

export async function processOverdueStartReminders(ioOverride = null) {
  const policy = await loadReminderPolicy();
  const intervalMinutes = policy.overdueStartIntervalMinutes;
  const visits = await findOverdueVisits();
  if (!visits.length) return { processed: 0, notified: 0 };

  const io = ioOverride ?? getSocketServer();
  let notified = 0;

  for (const visit of visits) {
    const providerId = Number(visit.serviceproviderid);
    const engagementId = Number(visit.engagement_id);
    const serviceDayId =
      visit.service_day_id != null ? Number(visit.service_day_id) : null;
    const scheduledStartEpoch = Number(visit.scheduled_start_epoch);

    if (!Number.isFinite(providerId) || !Number.isFinite(engagementId)) continue;

    const recentlySent = await wasReminderSentRecently({
      providerId,
      engagementId,
      serviceDayId,
      intervalMinutes,
    });
    if (recentlySent) continue;

    const body = buildReminderMessage(engagementId, scheduledStartEpoch);
    const title = "Service not started";

    try {
      await createInAppNotification({
        io,
        recipientType: "provider",
        recipientId: providerId,
        type: InAppTypes.SERVICE_START_OVERDUE,
        title,
        body,
        engagementId,
        metadata: {
          service_day_id: serviceDayId,
          scheduled_start_epoch: scheduledStartEpoch,
          scheduled_start_label: formatStartLabel(scheduledStartEpoch),
          booking_type: visit.booking_type,
          service_type: visit.service_type,
          customer_name: [visit.customer_firstname, visit.customer_lastname]
            .filter(Boolean)
            .join(" ")
            .trim(),
        },
      });
    } catch (err) {
      console.error(
        `[overdue-reminder] in-app failed engagement=${engagementId}:`,
        err?.message || err
      );
      continue;
    }

    if (io) {
      io.to(`provider_${providerId}`).emit("provider_overdue_visit", {
        engagement_id: engagementId,
        service_day_id: serviceDayId,
        scheduled_start_epoch: scheduledStartEpoch,
        scheduled_start_label: formatStartLabel(scheduledStartEpoch),
        message: body,
      });
    }

    await sendReminderPushOptional(visit.provider_email, title, body, engagementId);
    await sendReminderSmsOptional(visit.provider_mobile, body);
    notified += 1;
  }

  return { processed: visits.length, notified };
}

let schedulerStarted = false;

export function startOverdueStartReminderScheduler(io = null) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = process.env.OVERDUE_START_REMINDER_ENABLED !== "false";
  if (!enabled) {
    console.log("[overdue-reminder] Scheduler disabled (OVERDUE_START_REMINDER_ENABLED=false)");
    return;
  }

  const tickMs = clampInt(process.env.OVERDUE_START_REMINDER_TICK_MS, 30_000, 300_000, 60_000);
  const startupDelayMs = clampInt(process.env.OVERDUE_START_REMINDER_STARTUP_DELAY_MS, 5_000, 120_000, 30_000);

  const tick = async () => {
    try {
      const result = await processOverdueStartReminders(io);
      if (result.notified > 0) {
        console.log(
          `[overdue-reminder] Sent ${result.notified} reminder(s) (${result.processed} overdue visit(s) checked)`
        );
      }
    } catch (err) {
      console.error("[overdue-reminder] tick failed:", err?.message || err);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(tick, tickMs);
  }, startupDelayMs);

  console.log(
    `[overdue-reminder] Scheduler started (tick every ${tickMs / 1000}s, interval from platform settings)`
  );
}
