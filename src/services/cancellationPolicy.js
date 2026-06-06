import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

export const DEFAULT_CANCELLATION_POLICY = {
  onDemandMinutesBeforeStart: 30,
  shortTermDaysBeforeStart: 2,
  monthlyDaysBeforeStart: 2,
};

let cachedPolicy = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function parseCancellationPolicy(settings) {
  const raw = settings?.cancellation;
  return {
    onDemandMinutesBeforeStart: clampInt(
      raw?.onDemandMinutesBeforeStart,
      0,
      24 * 60,
      DEFAULT_CANCELLATION_POLICY.onDemandMinutesBeforeStart
    ),
    shortTermDaysBeforeStart: clampInt(
      raw?.shortTermDaysBeforeStart,
      0,
      365,
      DEFAULT_CANCELLATION_POLICY.shortTermDaysBeforeStart
    ),
    monthlyDaysBeforeStart: clampInt(
      raw?.monthlyDaysBeforeStart,
      0,
      365,
      DEFAULT_CANCELLATION_POLICY.monthlyDaysBeforeStart
    ),
  };
}

export async function loadCancellationPolicy() {
  const now = Date.now();
  if (cachedPolicy && now - cachedAt < CACHE_MS) {
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
      cachedPolicy = parseCancellationPolicy(data?.settings ?? data);
      cachedAt = now;
      return cachedPolicy;
    }
  } catch {
    // fall through to defaults
  }

  cachedPolicy = { ...DEFAULT_CANCELLATION_POLICY };
  cachedAt = now;
  return cachedPolicy;
}

function normalizeBookingType(bookingType) {
  return String(bookingType || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function daysBeforeStartForType(bookingType, policy) {
  if (bookingType === "MONTHLY") return policy.monthlyDaysBeforeStart;
  return policy.shortTermDaysBeforeStart;
}

function toEpochOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isCancellationAllowed(engagement, policy, nowUnix = dayjs().unix()) {
  const bookingType = normalizeBookingType(engagement.booking_type);
  const startEpoch = toEpochOrNull(engagement.start_epoch);
  const startDate = engagement.start_date
    ? dayjs(engagement.start_date).format("YYYY-MM-DD")
    : null;

  if (bookingType === "ON_DEMAND") {
    if (startEpoch == null) return false;
    const cutoff = startEpoch - policy.onDemandMinutesBeforeStart * 60;
    return nowUnix < cutoff;
  }

  if (startDate && dayjs(startDate).isValid()) {
    const daysBefore = daysBeforeStartForType(bookingType, policy);
    const lastCancelDay = dayjs(startDate).startOf("day").subtract(daysBefore, "day");
    return !dayjs.unix(nowUnix).startOf("day").isAfter(lastCancelDay);
  }

  if (startEpoch == null) return false;
  const daysBefore = daysBeforeStartForType(bookingType, policy);
  const lastCancelDay = dayjs.unix(startEpoch).startOf("day").subtract(daysBefore, "day");
  return !dayjs.unix(nowUnix).startOf("day").isAfter(lastCancelDay);
}

export function getCancellationDeniedMessage(engagement, policy) {
  const bookingType = normalizeBookingType(engagement.booking_type);

  if (bookingType === "ON_DEMAND") {
    const minutes = policy.onDemandMinutesBeforeStart;
    return `Cancellation is only allowed at least ${minutes} minute${minutes === 1 ? "" : "s"} before the scheduled start time.`;
  }

  const days = daysBeforeStartForType(bookingType, policy);
  const label = bookingType === "MONTHLY" ? "monthly" : "short-term";
  return `Cancellation for ${label} bookings is only allowed until ${days} day${days === 1 ? "" : "s"} before the service start date.`;
}

export function assertCancellationAllowed(engagement, policy) {
  if (isCancellationAllowed(engagement, policy)) return;
  const err = new Error(getCancellationDeniedMessage(engagement, policy));
  err.statusCode = 400;
  throw err;
}
