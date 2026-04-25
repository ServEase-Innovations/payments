/**
 * Read-only: trace data for a provider used by `POST /api/v2/service-providers/nearby-monthly`
 *
 *   POSTGRES_*=... node scripts/traceNearbyForSp.mjs 126 2026-05-01 2026-05-22 COOK
 */
import pg from "pg";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

const sp = Number(process.argv[2] || 126, 10);
const startDate = process.argv[3] || "2026-05-01";
const endDate = process.argv[4] || "2026-05-22";
const role = process.argv[5] || "COOK";

function calendarYmdKolkata(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

function isDateInEngagementVacation(dateYmd, vacationStart, vacationEnd) {
  if (vacationStart == null || vacationEnd == null) return false;
  const d = calendarYmdKolkata(dateYmd);
  const a = calendarYmdKolkata(vacationStart);
  const b = calendarYmdKolkata(vacationEnd);
  if (!d || !a || !b) return false;
  return d >= a && d <= b;
}

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  port: Number(process.env.POSTGRES_PORT) || 5432,
});

const eng = await pool.query(
  `SELECT engagement_id, service_type, vacation_start_date, vacation_end_date
   FROM engagements
   WHERE serviceproviderid = $1::bigint
     AND active = true
     AND (engagement_status = 'ASSIGNED' OR assignment_status = 'ASSIGNED')
     AND (
       service_type IS NULL
       OR LOWER(TRIM(service_type::text)) = LOWER(TRIM($2::text))
     )`,
  [sp, role]
);

const rStart = dayjs.tz(calendarYmdKolkata(startDate), "YYYY-MM-DD", "Asia/Kolkata");
const rEnd = dayjs.tz(calendarYmdKolkata(endDate), "YYYY-MM-DD", "Asia/Kolkata");

const vacationSet = new Set();
for (const e of eng.rows) {
  for (let c = rStart.clone(); !c.isAfter(rEnd, "day"); c = c.add(1, "day")) {
    const ds = c.format("YYYY-MM-DD");
    if (isDateInEngagementVacation(ds, e.vacation_start_date, e.vacation_end_date)) {
      vacationSet.add(`${String(sp)}:${ds}`);
    }
  }
}

const freePa = await pool.query(
  `SELECT date::text AS d FROM provider_availability
   WHERE serviceproviderid = $1::bigint
     AND LOWER(TRIM(COALESCE(status::text,''))) = 'free'
     AND date::date >= $2::date AND date::date <= $3::date`,
  [sp, startDate, endDate]
);

const paFree = new Set(freePa.rows.map((r) => `${String(sp)}:${r.d.trim().slice(0, 10)}`));
const combined = new Set([...vacationSet, ...paFree]);

let cleared = 0;
for (let c = rStart.clone(); !c.isAfter(rEnd, "day"); c = c.add(1, "day")) {
  if (combined.has(`${String(sp)}:${c.format("YYYY-MM-DD")}`)) cleared++;
}

console.log("SP", sp, "role", startDate, "to", endDate, role);
console.log("engagements (filtered):", eng.rows);
console.log("engagement-vacation keys in window (sample):", [...vacationSet].slice(0, 5), "count", vacationSet.size);
console.log("PA FREE keys in window (sample):", [...paFree].slice(0, 5), "count", paFree.size);
console.log("--- Expect `clearedContractVisitDaysInRange` in API to equal (union):", cleared, "out of", rEnd.diff(rStart, "day") + 1, "days");

await pool.end();
