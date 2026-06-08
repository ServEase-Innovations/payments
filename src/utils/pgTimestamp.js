import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const IST = "Asia/Kolkata";
const PLACED_TODAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Postgres `timestamp without time zone` / Date → canonical UTC ISO for clients. */
export function pgTimestampToIsoUtc(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return dayjs.utc(value).toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/Z$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return dayjs(s).utc().toISOString();
  }
  return dayjs.utc(s.replace(" ", "T")).toISOString();
}

/** Human label for when a booking was placed (IST). */
export function formatPlacedAtIstLabel(value) {
  const iso = pgTimestampToIsoUtc(value);
  if (!iso) return null;
  const ms = dayjs(iso).valueOf();
  const now = dayjs().tz(IST);
  const d = dayjs(ms).tz(IST);
  const timePart = d.format("h:mm A");
  const ageMs = now.valueOf() - ms;
  if (ageMs >= 0 && ageMs < PLACED_TODAY_WINDOW_MS) {
    return `Today at ${timePart}`;
  }
  if (d.isSame(now, "day")) return `Today at ${timePart}`;
  const yesterday = now.startOf("day").subtract(1, "day");
  if (d.isSame(yesterday, "day")) return `Yesterday at ${timePart}`;
  return d.format("MMM D, YYYY [at] h:mm A");
}

export function normalizePaymentTimestamps(payment) {
  if (!payment || typeof payment !== "object") return payment;
  const created = pgTimestampToIsoUtc(payment.created_at);
  return created ? { ...payment, created_at: created } : payment;
}
