import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { activeEngagementStatusSql } from "./providerAvailabilityOverlap.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export const ON_DEMAND_PROVIDER_RADIUS_KM = 5;

export const ON_DEMAND_NO_PROVIDERS_MESSAGE =
  "No service providers are currently available in your area. Please try again later or choose a different location.";

const ROLE_MATCH_SQL = `
  (
    EXISTS (
      SELECT 1
      FROM serviceprovider_roles r
      WHERE r.serviceproviderid = sp.serviceproviderid
        AND LOWER(TRIM(r.role::text)) = LOWER(TRIM($3::text))
    )
    OR (
      NOT EXISTS (
        SELECT 1
        FROM serviceprovider_roles r2
        WHERE r2.serviceproviderid = sp.serviceproviderid
      )
      AND LOWER(TRIM(COALESCE(sp.housekeepingrole, ''::text))) = LOWER(TRIM($3::text))
    )
    OR (
      LOWER(TRIM(COALESCE(sp.housekeepingrole, ''::text))) = LOWER(TRIM($3::text))
      AND NOT EXISTS (
        SELECT 1
        FROM serviceprovider_roles r3
        WHERE r3.serviceproviderid = sp.serviceproviderid
          AND LOWER(TRIM(r3.role::text)) = LOWER(TRIM($3::text))
      )
    )
  )
`;

export function serviceTypeToRole(serviceType) {
  const s = String(serviceType || "")
    .trim()
    .toUpperCase();
  if (s === "MAID" || s === "CLEANING") return "MAID";
  if (s === "NANNY" || s === "CAREGIVER") return "NANNY";
  if (s === "COOK" || s === "MEAL" || s === "COOKING") return "COOK";
  return s || "COOK";
}

export function normalizeBookingCoordinates(latitude, longitude) {
  if (latitude == null || longitude == null || latitude === "" || longitude === "") {
    return null;
  }
  let lat = Number(latitude);
  let lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    [lat, lng] = [lng, lat];
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  if (lat === 0 && lng === 0) {
    return null;
  }
  return { lat, lng };
}

function parseTimeslotRanges(timeslot) {
  if (!timeslot || typeof timeslot !== "string") return [];
  return timeslot
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [start, end] = part.split("-").map((s) => s?.trim()?.slice(0, 5));
      if (!start || !end || start >= end) return null;
      return { start, end };
    })
    .filter(Boolean);
}

/** True when provider has no timeslot or the visit start (HH:mm) falls in a configured range. */
export function isWithinProviderTimeslot(timeslot, startTimeHm) {
  const ranges = parseTimeslotRanges(timeslot);
  if (!ranges.length) return true;
  const t = String(startTimeHm || "").trim().slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(t)) return true;
  return ranges.some((r) => t >= r.start && t < r.end);
}

/**
 * Count active providers for an on-demand visit: matching role, within radius,
 * not blocked by an overlapping BOOKED slot, and within working hours when timeslot is set.
 */
export async function countAvailableOnDemandProviders(
  {
    latitude,
    longitude,
    serviceType,
    visitDateYmd,
    startEpoch,
    endEpoch,
    radiusKm = ON_DEMAND_PROVIDER_RADIUS_KM,
  },
  db = pool
) {
  const coords = normalizeBookingCoordinates(latitude, longitude);
  if (!coords) {
    return { ok: false, count: 0, reason: "INVALID_COORDINATES" };
  }

  const role = serviceTypeToRole(serviceType);
  const startEp = Number(startEpoch);
  const endEp = Number(endEpoch);
  if (!Number.isFinite(startEp) || startEp <= 0) {
    return { ok: false, count: 0, reason: "INVALID_SCHEDULE" };
  }
  const slotEnd = Number.isFinite(endEp) && endEp > startEp ? endEp : startEp + 3600;
  const visitDate =
    visitDateYmd ||
    dayjs.unix(startEp).tz("Asia/Kolkata").format("YYYY-MM-DD");
  const startTimeHm = dayjs.unix(startEp).tz("Asia/Kolkata").format("HH:mm");
  const dayWindowStart = dayjs
    .tz(visitDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day")
    .unix();
  const dayWindowEnd = dayWindowStart + 86400;

  const { rows } = await db.query(
    `
    SELECT sp.serviceproviderid, sp.timeslot
    FROM serviceprovider sp
    WHERE sp.isactive = true
      AND sp.latitude IS NOT NULL
      AND sp.longitude IS NOT NULL
      AND ${ROLE_MATCH_SQL}
      AND (
        6371 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians($1)) * cos(radians(sp.latitude)) *
            cos(radians(sp.longitude) - radians($2)) +
            sin(radians($1)) * sin(radians(sp.latitude))
          ))
        )
      ) <= $4
      AND NOT EXISTS (
        SELECT 1
        FROM provider_availability pa
        INNER JOIN engagements e ON e.engagement_id = pa.engagement_id
        WHERE pa.serviceproviderid = sp.serviceproviderid
          AND pa.status = 'BOOKED'
          AND pa.date = $5::date
          AND pa.slot_start_epoch IS NOT NULL
          AND pa.slot_end_epoch IS NOT NULL
          AND ${activeEngagementStatusSql("e")}
          AND GREATEST(pa.slot_start_epoch, $6::bigint) < LEAST(pa.slot_end_epoch, $7::bigint)
          AND $8::bigint < LEAST(pa.slot_end_epoch, $7::bigint)
          AND $9::bigint > GREATEST(pa.slot_start_epoch, $6::bigint)
      )
    `,
    [
      coords.lat,
      coords.lng,
      role,
      Number(radiusKm),
      visitDate,
      dayWindowStart,
      dayWindowEnd,
      startEp,
      slotEnd,
    ]
  );

  const available = rows.filter((row) =>
    isWithinProviderTimeslot(row.timeslot, startTimeHm)
  );

  return {
    ok: true,
    count: available.length,
    role,
    radiusKm: Number(radiusKm),
  };
}

export async function assertOnDemandProvidersAvailable(params, db = pool) {
  const result = await countAvailableOnDemandProviders(params, db);
  if (!result.ok) {
    if (result.reason === "INVALID_COORDINATES") {
      return {
        available: false,
        count: 0,
        message:
          "A valid service location is required before booking on-demand service.",
        code: "INVALID_COORDINATES",
      };
    }
    return {
      available: false,
      count: 0,
      message: "Select a valid date and time for your booking.",
      code: result.reason,
    };
  }

  if (result.count < 1) {
    return {
      available: false,
      count: 0,
      message: ON_DEMAND_NO_PROVIDERS_MESSAGE,
      code: "NO_PROVIDERS_NEARBY",
    };
  }

  return {
    available: true,
    count: result.count,
    role: result.role,
    radiusKm: result.radiusKm,
  };
}
