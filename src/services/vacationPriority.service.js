import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { activeEngagementStatusSql } from "./providerAvailabilityOverlap.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function calendarYmd(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

/**
 * Active customer vacations where the SP is reserved (vacation-priority), not freed.
 * @param {{ asOfDate?: string, scope?: 'active'|'future', overlapDate?: string }} opts
 */
export async function listActiveVacationPriorityEngagements(
  db = pool,
  { asOfDate, scope = "active", overlapDate } = {}
) {
  const today = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");
  const refDate = overlapDate || asOfDate || today;

  let dateClause = "$1::date BETWEEN e.vacation_start_date AND e.vacation_end_date";
  const params = [refDate];

  if (scope === "future") {
    dateClause = "e.vacation_end_date >= $1::date";
    params[0] = today;
  }

  const { rows } = await db.query(
    `
    SELECT
      e.engagement_id,
      e.customerid,
      e.serviceproviderid,
      e.vacation_priority_provider_id,
      e.booking_type,
      e.service_type,
      e.start_date,
      e.end_date,
      e.vacation_start_date,
      e.vacation_end_date,
      e.leave_days,
      e.start_epoch,
      e.end_epoch,
      e.address,
      c.firstname AS customer_firstname,
      c.lastname AS customer_lastname,
      c.mobileno AS customer_mobile,
      sp.serviceproviderid AS provider_id,
      sp.firstname AS provider_firstname,
      sp.lastname AS provider_lastname,
      sp.mobileno AS provider_mobile,
      sp.latitude AS provider_latitude,
      sp.longitude AS provider_longitude
    FROM engagements e
    JOIN customer c ON c.customerid = e.customerid
    JOIN serviceprovider sp ON sp.serviceproviderid = COALESCE(
      e.vacation_priority_provider_id,
      e.serviceproviderid
    )
    WHERE e.vacation_start_date IS NOT NULL
      AND e.vacation_end_date IS NOT NULL
      AND ${dateClause}
      AND ${activeEngagementStatusSql("e")}
      AND UPPER(COALESCE(e.booking_type, '')) IN ('MONTHLY', 'SHORT_TERM')
    ORDER BY e.vacation_start_date ASC, e.engagement_id ASC
    `,
    params
  );

  return rows.map((r) => ({
    engagement_id: Number(r.engagement_id),
    customer: {
      customerid: Number(r.customerid),
      firstname: r.customer_firstname,
      lastname: r.customer_lastname,
      mobile: r.customer_mobile,
    },
    provider: {
      serviceproviderid: Number(r.provider_id),
      firstname: r.provider_firstname,
      lastname: r.provider_lastname,
      mobile: r.provider_mobile,
      latitude: r.provider_latitude != null ? Number(r.provider_latitude) : null,
      longitude: r.provider_longitude != null ? Number(r.provider_longitude) : null,
    },
    booking_type: r.booking_type,
    service_type: r.service_type,
    vacation_start_date: calendarYmd(r.vacation_start_date),
    vacation_end_date: calendarYmd(r.vacation_end_date),
    leave_days: Number(r.leave_days || 0),
    contract_start_date: calendarYmd(r.start_date),
    contract_end_date: calendarYmd(r.end_date),
    address: r.address || null,
    vacation_priority_provider_id:
      r.vacation_priority_provider_id != null
        ? Number(r.vacation_priority_provider_id)
        : Number(r.serviceproviderid),
  }));
}

/**
 * Unassigned on-demand engagements overlapping a vacation window (for admin assignment).
 */
export async function listPendingOnDemandForVacationWindow(
  db,
  { vacationStart, vacationEnd, serviceType }
) {
  const { rows } = await db.query(
    `
    SELECT
      e.engagement_id,
      e.service_type,
      e.start_date,
      e.start_epoch,
      e.end_epoch,
      e.address,
      e.latitude,
      e.longitude,
      c.customerid,
      c.firstname AS customer_firstname,
      c.lastname AS customer_lastname
    FROM engagements e
    JOIN customer c ON c.customerid = e.customerid
    WHERE UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
      AND UPPER(COALESCE(e.assignment_status, '')) = 'UNASSIGNED'
      AND e.serviceproviderid IS NULL
      AND ${activeEngagementStatusSql("e")}
      AND e.start_date::date BETWEEN $1::date AND $2::date
      AND (
        $3::text IS NULL
        OR LOWER(TRIM(e.service_type::text)) = LOWER(TRIM($3::text))
        OR (
          LOWER(TRIM($3::text)) LIKE '%cook%'
          AND LOWER(TRIM(e.service_type::text)) LIKE '%cook%'
        )
      )
    ORDER BY e.start_epoch ASC NULLS LAST
    LIMIT 50
    `,
    [vacationStart, vacationEnd, serviceType || null]
  );

  return rows.map((r) => ({
    engagement_id: Number(r.engagement_id),
    service_type: r.service_type,
    start_date: calendarYmd(r.start_date),
    start_epoch: r.start_epoch != null ? Number(r.start_epoch) : null,
    address: r.address || null,
    customer: {
      customerid: Number(r.customerid),
      firstname: r.customer_firstname,
      lastname: r.customer_lastname,
    },
  }));
}
