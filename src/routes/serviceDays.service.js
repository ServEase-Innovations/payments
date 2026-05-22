// services/serviceDays.service.js — calendar days in Asia/Kolkata (matches PA + today-bookings)

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { PG_IST_TODAY_DATE } from "../config/istDateSql.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export async function createServiceDays(client, engagementId, startDate, endDate) {
  const startStr = String(startDate ?? "").trim().slice(0, 10);
  const endStr = String(endDate ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
    return;
  }

  const query = `
    INSERT INTO service_days (engagement_id, service_date, status)
    VALUES ($1, $2::date, 'SCHEDULED')
    ON CONFLICT (engagement_id, service_date) DO NOTHING
  `;

  let d = dayjs.tz(startStr, "YYYY-MM-DD", "Asia/Kolkata");
  const end = dayjs.tz(endStr, "YYYY-MM-DD", "Asia/Kolkata");
  if (!d.isValid() || !end.isValid()) return;

  while (d.isBefore(end, "day") || d.isSame(end, "day")) {
    await client.query(query, [engagementId, d.format("YYYY-MM-DD")]);
    d = d.add(1, "day");
  }
}

/**
 * Ensures `service_days` rows exist for IST today when the engagement is active today.
 * Fixes v2 ON_DEMAND accepts (PA only) and older bookings missing today's row.
 */
export async function repairTodayServiceDays(client, engagementIds) {
  if (!engagementIds?.length) return;

  const missingDays = await client.query(
    `
    SELECT engagement_id, start_date, end_date
    FROM engagements e
    WHERE e.engagement_id = ANY($1::int[])
      AND e.assignment_status = 'ASSIGNED'
      AND e.booking_type IN ('SHORT_TERM', 'MONTHLY')
      AND NOT EXISTS (
        SELECT 1 FROM service_days sd WHERE sd.engagement_id = e.engagement_id
      )
    `,
    [engagementIds]
  );

  for (const row of missingDays.rows) {
    await createServiceDays(
      client,
      row.engagement_id,
      row.start_date,
      row.end_date
    );
  }

  await client.query(
    `
    INSERT INTO service_days (engagement_id, service_date, status)
    SELECT e.engagement_id, ${PG_IST_TODAY_DATE}, 'SCHEDULED'
    FROM engagements e
    WHERE e.engagement_id = ANY($1::int[])
      AND e.assignment_status = 'ASSIGNED'
      AND NOT EXISTS (
        SELECT 1 FROM service_days sd
        WHERE sd.engagement_id = e.engagement_id
          AND sd.service_date = ${PG_IST_TODAY_DATE}
      )
      AND (
        EXISTS (
          SELECT 1 FROM provider_availability pa
          WHERE pa.engagement_id = e.engagement_id
            AND pa.date = ${PG_IST_TODAY_DATE}
            AND pa.status = 'BOOKED'
        )
        OR (
          e.booking_type IN ('SHORT_TERM', 'MONTHLY')
          AND e.start_date <= ${PG_IST_TODAY_DATE}
          AND COALESCE(e.end_date, e.start_date) >= ${PG_IST_TODAY_DATE}
        )
        OR (
          e.booking_type = 'ON_DEMAND'
          AND e.start_epoch IS NOT NULL
          AND (to_timestamp(e.start_epoch) AT TIME ZONE 'Asia/Kolkata')::date = ${PG_IST_TODAY_DATE}
        )
        OR (
          e.booking_type = 'ON_DEMAND'
          AND e.start_date = ${PG_IST_TODAY_DATE}
        )
      )
    ON CONFLICT (engagement_id, service_date) DO NOTHING
    `,
    [engagementIds]
  );
}
