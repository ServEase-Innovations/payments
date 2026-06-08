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
  return `UPPER(COALESCE(${alias}.engagement_status, '')) NOT IN (${list})`;
}

export function calendarYmd(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

/** Real visit window for overlap checks (clips bad end_epoch / contract-length duration). */
export function visitWindowFromEngagement(engagement) {
  const startEpoch = Number(engagement.start_epoch);
  if (!Number.isFinite(startEpoch)) {
    return null;
  }

  const rawDur = Number(engagement.duration_minutes);
  const durationMin = Math.min(
    Math.max(Number.isFinite(rawDur) ? rawDur : 60, 15),
    MAX_SERVICE_DURATION_MINUTES
  );
  const durationSec = durationMin * 60;

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

  let current = dayjs
    .tz(window.startDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day");
  const last = dayjs
    .tz(window.endDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day");

  while (!current.isAfter(last, "day")) {
    const day = current.format("YYYY-MM-DD");
    const dayWindowStart = current.unix();
    const dayWindowEnd = dayWindowStart + 86400;

    const dayStartEpoch = Math.max(window.startEpoch, dayWindowStart);
    const dayEndEpoch = Math.min(window.endEpoch, dayWindowEnd);

    if (dayStartEpoch >= dayEndEpoch) {
      current = current.add(1, "day");
      continue;
    }

    const params = [
      spid,
      day,
      dayStartEpoch,
      dayEndEpoch,
      dayWindowStart,
      dayWindowEnd,
    ];
    let excludeClause = "";
    if (Number.isFinite(excludeEid) && excludeEid > 0) {
      excludeClause = "AND pa.engagement_id IS DISTINCT FROM $7";
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
        ${excludeClause}
        AND GREATEST(pa.slot_start_epoch, $5::bigint) < LEAST(pa.slot_end_epoch, $6::bigint)
        AND $3::bigint < LEAST(pa.slot_end_epoch, $6::bigint)
        AND $4::bigint > GREATEST(pa.slot_start_epoch, $5::bigint)
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
