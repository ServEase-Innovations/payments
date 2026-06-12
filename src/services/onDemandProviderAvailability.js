import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import {
  activeEngagementStatusSql,
  completedServiceDayConflictExclusionSql,
} from "./providerAvailabilityOverlap.js";
import {
  ON_DEMAND_PROVIDER_RADIUS_KM,
  ON_DEMAND_NO_PROVIDERS_MESSAGE,
  ON_DEMAND_ROLE_MATCH_SQL,
  serviceTypeToRole,
  normalizeBookingCoordinates,
  isWithinProviderTimeslot,
} from "./onDemandProviderAvailability.helpers.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export {
  ON_DEMAND_PROVIDER_RADIUS_KM,
  ON_DEMAND_NO_PROVIDERS_MESSAGE,
  serviceTypeToRole,
  normalizeBookingCoordinates,
  isWithinProviderTimeslot,
} from "./onDemandProviderAvailability.helpers.js";

function resolveVisitParams({
  latitude,
  longitude,
  serviceType,
  visitDateYmd,
  startEpoch,
  endEpoch,
  radiusKm = ON_DEMAND_PROVIDER_RADIUS_KM,
}) {
  const coords = normalizeBookingCoordinates(latitude, longitude);
  if (!coords) {
    return { ok: false, reason: "INVALID_COORDINATES" };
  }

  const role = serviceTypeToRole(serviceType);
  const startEp = Number(startEpoch);
  const endEp = Number(endEpoch);
  if (!Number.isFinite(startEp) || startEp <= 0) {
    return { ok: false, reason: "INVALID_SCHEDULE" };
  }

  const slotEnd = Number.isFinite(endEp) && endEp > startEp ? endEp : startEp + 3600;
  const visitDate =
    visitDateYmd || dayjs.unix(startEp).tz("Asia/Kolkata").format("YYYY-MM-DD");
  const startTimeHm = dayjs.unix(startEp).tz("Asia/Kolkata").format("HH:mm");
  const dayWindowStart = dayjs
    .tz(visitDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day")
    .unix();
  const dayWindowEnd = dayWindowStart + 86400;

  return {
    ok: true,
    coords,
    role,
    startEp,
    slotEnd,
    visitDate,
    startTimeHm,
    dayWindowStart,
    dayWindowEnd,
    radiusKm: Number(radiusKm),
  };
}

async function queryOnDemandProvidersInArea(params, db = pool) {
  const resolved = resolveVisitParams(params);
  if (!resolved.ok) return resolved;

  const providerId =
    params.providerId != null && Number.isFinite(Number(params.providerId))
      ? Number(params.providerId)
      : null;

  const { rows } = await db.query(
    `
    SELECT sp.serviceproviderid, sp.timeslot
    FROM serviceprovider sp
    WHERE sp.isactive = true
      AND sp.latitude IS NOT NULL
      AND sp.longitude IS NOT NULL
      AND ($10::int IS NULL OR sp.serviceproviderid = $10::int)
      AND ${ON_DEMAND_ROLE_MATCH_SQL}
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
          AND ${completedServiceDayConflictExclusionSql("pa", "e")}
          AND GREATEST(pa.slot_start_epoch, $6::bigint) < LEAST(pa.slot_end_epoch, $7::bigint)
          AND $8::bigint < LEAST(pa.slot_end_epoch, $7::bigint)
          AND $9::bigint > GREATEST(pa.slot_start_epoch, $6::bigint)
      )
    `,
    [
      resolved.coords.lat,
      resolved.coords.lng,
      resolved.role,
      resolved.radiusKm,
      resolved.visitDate,
      resolved.dayWindowStart,
      resolved.dayWindowEnd,
      resolved.startEp,
      resolved.slotEnd,
      providerId,
    ]
  );

  return { ok: true, rows, ...resolved, providerId };
}

/**
 * Broadcast-eligible providers: role + radius + no slot conflict (schedule optional).
 */
export async function countBroadcastEligibleOnDemandProviders(params, db = pool) {
  const result = await queryOnDemandProvidersInArea(params, db);
  if (!result.ok) return result;

  return {
    ok: true,
    count: result.rows.length,
    role: result.role,
    radiusKm: result.radiusKm,
  };
}

/**
 * Strictly available providers: also within configured working-hours timeslot.
 */
export async function countAvailableOnDemandProviders(params, db = pool) {
  const result = await queryOnDemandProvidersInArea(params, db);
  if (!result.ok) return result;

  const available = result.rows.filter((row) =>
    isWithinProviderTimeslot(row.timeslot, result.startTimeHm)
  );

  return {
    ok: true,
    count: available.length,
    broadcastEligibleCount: result.rows.length,
    role: result.role,
    radiusKm: result.radiusKm,
  };
}

export async function assertOnDemandProvidersAvailable(params, db = pool) {
  const broadcast = await countBroadcastEligibleOnDemandProviders(params, db);
  if (!broadcast.ok) {
    if (broadcast.reason === "INVALID_COORDINATES") {
      return {
        available: false,
        count: 0,
        broadcastEligibleCount: 0,
        message:
          "A valid service location is required before booking on-demand service.",
        code: "INVALID_COORDINATES",
      };
    }
    return {
      available: false,
      count: 0,
      broadcastEligibleCount: 0,
      message: "Select a valid date and time for your booking.",
      code: broadcast.reason,
    };
  }

  const strict = await countAvailableOnDemandProviders(params, db);
  const strictCount = strict.ok ? strict.count : 0;

  if (broadcast.count < 1) {
    const singleProvider =
      params.providerId != null && Number.isFinite(Number(params.providerId));
    return {
      available: false,
      count: 0,
      broadcastEligibleCount: 0,
      strictCount,
      message: singleProvider
        ? "This provider is not available for your selected date, time, or location."
        : ON_DEMAND_NO_PROVIDERS_MESSAGE,
      code: singleProvider ? "PROVIDER_UNAVAILABLE" : "NO_PROVIDERS_NEARBY",
    };
  }

  return {
    available: true,
    count: broadcast.count,
    broadcastEligibleCount: broadcast.count,
    strictCount,
    role: broadcast.role,
    radiusKm: broadcast.radiusKm,
  };
}
