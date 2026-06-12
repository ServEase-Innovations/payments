import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export const MAX_SERVICE_DURATION_MINUTES = 24 * 60;

/** Engagements in these states must not block provider availability. */
export const TERMINAL_ENGAGEMENT_STATUSES = [
  "CANCELLED",
  "COMPLETED",
  "CLOSED",
  "EXPIRED",
];

export function activeEngagementStatusSql(alias = "e") {
  const list = TERMINAL_ENGAGEMENT_STATUSES.map((s) => `'${s}'`).join(", ");
  return `(
    UPPER(COALESCE(${alias}.engagement_status, '')) NOT IN (${list})
    AND UPPER(COALESCE(${alias}.task_status, 'NOT_STARTED')) NOT IN ('CANCELLED', 'COMPLETED')
  )`;
}

/** BOOKED slots for visits already marked complete must not block new accepts. */
export function completedServiceDayConflictExclusionSql(
  paAlias = "pa",
  engAlias = "e"
) {
  return `NOT EXISTS (
    SELECT 1
    FROM service_days sd_done
    WHERE sd_done.engagement_id = ${engAlias}.engagement_id
      AND sd_done.service_date = ${paAlias}.date
      AND UPPER(COALESCE(sd_done.status, '')) IN ('COMPLETED', 'CANCELLED', 'SKIPPED')
  )`;
}

export function calendarYmd(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

/** Per-visit duration in seconds (not the full contract span). */
export function visitDurationSecondsFromEngagement(engagement, opts = {}) {
  const startTimeStr =
    opts.startTime ??
    (Number.isFinite(Number(engagement.start_epoch))
      ? dayjs.unix(Number(engagement.start_epoch)).tz("Asia/Kolkata").format("HH:mm")
      : null);
  const endTimeStr = opts.endTime ?? null;

  if (startTimeStr && endTimeStr) {
    const ref =
      calendarYmd(engagement.start_date) ||
      (Number.isFinite(Number(engagement.start_epoch))
        ? dayjs.unix(Number(engagement.start_epoch)).tz("Asia/Kolkata").format("YYYY-MM-DD")
        : null);
    if (ref) {
      const s = dayjs
        .tz(`${ref} ${startTimeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata")
        .unix();
      const e = dayjs
        .tz(`${ref} ${endTimeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata")
        .unix();
      if (Number.isFinite(s) && Number.isFinite(e) && e > s && e - s <= 86400) {
        return e - s;
      }
    }
  }

  const rawDur = Number(engagement.duration_minutes);
  const durationMin = Math.min(
    Math.max(Number.isFinite(rawDur) ? rawDur : 60, 15),
    MAX_SERVICE_DURATION_MINUTES
  );
  return durationMin * 60;
}

/** Real visit window for overlap checks (clips bad end_epoch / contract-length duration). */
export function visitWindowFromEngagement(engagement) {
  const startEpoch = Number(engagement.start_epoch);
  if (!Number.isFinite(startEpoch)) {
    return null;
  }

  const durationSec = visitDurationSecondsFromEngagement(engagement);

  let endEpoch = Number(engagement.end_epoch);
  if (
    !Number.isFinite(endEpoch) ||
    endEpoch <= startEpoch ||
    endEpoch - startEpoch > durationSec + 60
  ) {
    endEpoch = startEpoch + durationSec;
  }

  const isOnDemand =
    String(engagement.booking_type || "").toUpperCase() === "ON_DEMAND";
  const startDate =
    calendarYmd(engagement.start_date) ||
    dayjs.unix(startEpoch).tz("Asia/Kolkata").format("YYYY-MM-DD");
  const endDate = isOnDemand
    ? startDate
    : calendarYmd(engagement.end_date) || startDate;

  return {
    startEpoch,
    endEpoch,
    durationSec,
    startDate,
    endDate,
    isOnDemand,
  };
}

/**
 * True if provider has another BOOKED slot overlapping this visit (IST day-clipped).
 * Excludes rows for `excludeEngagementId` (same job being accepted).
 */
export async function findProviderBookedConflict(
  client,
  providerId,
  engagement,
  excludeEngagementId = null
) {
  const window = visitWindowFromEngagement(engagement);
  if (!window) return null;

  const spid = Number(providerId);
  const excludeEid =
    excludeEngagementId != null ? Number(excludeEngagementId) : null;

  const visitTime = dayjs
    .unix(window.startEpoch)
    .tz("Asia/Kolkata")
    .format("HH:mm");

  let current = dayjs
    .tz(window.startDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day");
  const last = dayjs
    .tz(window.endDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day");

  while (!current.isAfter(last, "day")) {
    const day = current.format("YYYY-MM-DD");
    const dayStartEpoch = dayjs
      .tz(`${day} ${visitTime}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata")
      .unix();
    const dayEndEpoch = dayStartEpoch + window.durationSec;

    if (
      !Number.isFinite(dayStartEpoch) ||
      !Number.isFinite(dayEndEpoch) ||
      dayEndEpoch <= dayStartEpoch
    ) {
      current = current.add(1, "day");
      continue;
    }

    const params = [spid, day, dayStartEpoch, dayEndEpoch];
    let excludeClause = "";
    if (Number.isFinite(excludeEid) && excludeEid > 0) {
      excludeClause = "AND pa.engagement_id IS DISTINCT FROM $5";
      params.push(excludeEid);
    }

    const overlap = await client.query(
      `
      SELECT pa.engagement_id, pa.date, pa.slot_start_epoch, pa.slot_end_epoch
      FROM provider_availability pa
      INNER JOIN engagements e ON e.engagement_id = pa.engagement_id
      WHERE pa.serviceproviderid = $1
        AND pa.status = 'BOOKED'
        AND pa.date = $2::date
        AND pa.slot_start_epoch IS NOT NULL
        AND pa.slot_end_epoch IS NOT NULL
        AND ${activeEngagementStatusSql("e")}
        AND ${completedServiceDayConflictExclusionSql("pa", "e")}
        ${excludeClause}
        AND $3::bigint < pa.slot_end_epoch
        AND $4::bigint > pa.slot_start_epoch
      LIMIT 1
      `,
      params
    );

    if (overlap.rows.length) {
      return overlap.rows[0];
    }

    current = current.add(1, "day");
  }

  return null;
}

/**
 * Remove or free provider_availability rows that must not block scheduling.
 * Cleans terminal engagements, dates outside contract window, and vacation days still marked BOOKED.
 */
export async function releaseNonBlockingProviderAvailabilityOnDates(
  client,
  providerId,
  dates
) {
  if (!dates?.length) return;

  await client.query(
    `SELECT 1 FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2::date[]) FOR UPDATE`,
    [providerId, dates]
  );

  await client.query(
    `DELETE FROM provider_availability pa
     USING engagements e
     WHERE pa.engagement_id = e.engagement_id
       AND pa.serviceproviderid = $1
       AND pa.date = ANY($2::date[])
       AND NOT (${activeEngagementStatusSql("e")})`,
    [providerId, dates]
  );

  await client.query(
    `UPDATE provider_availability pa
     SET status = 'FREE', slot_start_epoch = NULL, slot_end_epoch = NULL, updated_at = NOW()
     FROM engagements e
     WHERE pa.engagement_id = e.engagement_id
       AND pa.serviceproviderid = $1
       AND pa.date = ANY($2::date[])
       AND pa.status = 'BOOKED'
       AND ${activeEngagementStatusSql("e")}
       AND (
         pa.date < e.start_date::date
         OR pa.date > e.end_date::date
       )`,
    [providerId, dates]
  );

  await client.query(
    `UPDATE provider_availability pa
     SET status = 'FREE', slot_start_epoch = NULL, slot_end_epoch = NULL, updated_at = NOW()
     FROM engagements e
     WHERE pa.engagement_id = e.engagement_id
       AND pa.serviceproviderid = $1
       AND pa.date = ANY($2::date[])
       AND pa.status = 'BOOKED'
       AND ${activeEngagementStatusSql("e")}
       AND e.vacation_start_date IS NOT NULL
       AND e.vacation_end_date IS NOT NULL
       AND pa.date >= e.vacation_start_date::date
       AND pa.date <= e.vacation_end_date::date`,
    [providerId, dates]
  );
}

/**
 * True if provider has another BOOKED slot overlapping this visit on any of `dates` (IST day-clipped).
 */
export async function findProviderBookedConflictOnDates(
  client,
  providerId,
  engagement,
  dates,
  excludeEngagementId = null
) {
  if (!dates?.length) return null;

  const window = visitWindowFromEngagement(engagement);
  if (!window) return null;

  const dateSet = new Set(dates.map((d) => calendarYmd(d)).filter(Boolean));
  const visitTime = dayjs.unix(window.startEpoch).tz("Asia/Kolkata").format("HH:mm");
  const spid = Number(providerId);
  const excludeEid =
    excludeEngagementId != null ? Number(excludeEngagementId) : null;

  for (const day of dateSet) {
    const dayStartEpoch = dayjs
      .tz(`${day} ${visitTime}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata")
      .unix();
    const dayEndEpoch = dayStartEpoch + window.durationSec;

    if (
      !Number.isFinite(dayStartEpoch) ||
      !Number.isFinite(dayEndEpoch) ||
      dayEndEpoch <= dayStartEpoch
    ) {
      continue;
    }

    const params = [spid, day, dayStartEpoch, dayEndEpoch];
    let excludeClause = "";
    if (Number.isFinite(excludeEid) && excludeEid > 0) {
      excludeClause = "AND pa.engagement_id IS DISTINCT FROM $5";
      params.push(excludeEid);
    }

    const overlap = await client.query(
      `
      SELECT pa.engagement_id, pa.date, pa.slot_start_epoch, pa.slot_end_epoch
      FROM provider_availability pa
      INNER JOIN engagements e ON e.engagement_id = pa.engagement_id
      WHERE pa.serviceproviderid = $1
        AND pa.status = 'BOOKED'
        AND pa.date = $2::date
        AND pa.date >= e.start_date::date
        AND pa.date <= e.end_date::date
        AND pa.slot_start_epoch IS NOT NULL
        AND pa.slot_end_epoch IS NOT NULL
        AND ${activeEngagementStatusSql("e")}
        AND ${completedServiceDayConflictExclusionSql("pa", "e")}
        ${excludeClause}
        AND $3::bigint < pa.slot_end_epoch
        AND $4::bigint > pa.slot_start_epoch
      LIMIT 1
      `,
      params
    );

    if (overlap.rows.length) {
      return overlap.rows[0];
    }
  }

  return null;
}
