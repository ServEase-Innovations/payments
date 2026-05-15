// services/serviceDays.service.js — calendar days in Asia/Kolkata (matches PA + today-bookings)

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

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
