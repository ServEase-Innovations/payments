/**
 * PostgreSQL expression for the calendar date in Asia/Kolkata (IST).
 * Use wherever service_days.service_date or provider_availability.date
 * is compared to "today" so it matches today-bookings and app logic.
 */
export const PG_IST_TODAY_DATE =
  "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date";
