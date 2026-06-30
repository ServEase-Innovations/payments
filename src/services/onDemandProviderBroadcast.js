import pool from "../config/db.js";
import geolib from "geolib";
import {
  ON_DEMAND_ROLE_MATCH_SQL,
  serviceTypeToRole,
  normalizeBookingCoordinates,
} from "./onDemandProviderAvailability.helpers.js";
import {
  activeEngagementStatusSql,
  completedServiceDayConflictExclusionSql,
} from "./providerAvailabilityOverlap.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

/** Max distance (m) to notify providers of a paid on-demand booking. */
export const ON_DEMAND_NOTIFY_RADIUS_M = 12_000;
export const ON_DEMAND_NOTIFY_FALLBACK_RADIUS_M = 30_000;

/**
 * Providers on customer vacation (VACATION_PRIORITY) — top tier for on-demand broadcast.
 */
export async function fetchVacationPriorityOnDemandProviders(
  {
    latitude,
    longitude,
    serviceType,
    visitDateYmd,
    startEpoch,
    endEpoch,
    radiusKm = 30,
    genderPreference = null,
  },
  db = pool
) {
  const coords = normalizeBookingCoordinates(latitude, longitude);
  if (!coords) return [];

  const role = serviceTypeToRole(serviceType);
  const startEp = Number(startEpoch);
  const endEp = Number(endEpoch);
  if (!Number.isFinite(startEp) || startEp <= 0) return [];

  const slotEnd = Number.isFinite(endEp) && endEp > startEp ? endEp : startEp + 3600;
  const visitDate =
    visitDateYmd || dayjs.unix(startEp).tz("Asia/Kolkata").format("YYYY-MM-DD");
  const dayWindowStart = dayjs
    .tz(visitDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day")
    .unix();
  const dayWindowEnd = dayWindowStart + 86400;

  // Build gender filter SQL
  const genderFilterSql = genderPreference && genderPreference !== 'No Preference'
    ? `AND UPPER(TRIM(COALESCE(sp.gender, ''))) = UPPER($10)`
    : '';
  
  const queryParams = [
    coords.lat,
    coords.lng,
    role,
    Number(radiusKm),
    visitDate,
    dayWindowStart,
    dayWindowEnd,
    startEp,
    slotEnd,
  ];
  
  if (genderPreference && genderPreference !== 'No Preference') {
    queryParams.push(genderPreference);
  }

  const { rows } = await db.query(
    `
    SELECT DISTINCT
      sp.serviceproviderid,
      sp.latitude,
      sp.longitude,
      sp.gender,
      e.engagement_id AS vacation_engagement_id
    FROM engagements e
    INNER JOIN serviceprovider sp ON sp.serviceproviderid = COALESCE(
      e.vacation_priority_provider_id,
      e.serviceproviderid
    )
    INNER JOIN provider_availability pa
      ON pa.engagement_id = e.engagement_id
     AND pa.serviceproviderid = sp.serviceproviderid
    WHERE sp.isactive = true
      AND sp.latitude IS NOT NULL
      AND sp.longitude IS NOT NULL
      AND e.vacation_start_date IS NOT NULL
      AND e.vacation_end_date IS NOT NULL
      AND $5::date BETWEEN e.vacation_start_date AND e.vacation_end_date
      AND pa.status = 'VACATION_PRIORITY'
      AND pa.date = $5::date
      AND ${activeEngagementStatusSql("e")}
      AND UPPER(COALESCE(e.booking_type, '')) IN ('MONTHLY', 'SHORT_TERM')
      AND ${ON_DEMAND_ROLE_MATCH_SQL}
      ${genderFilterSql}
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
        FROM provider_availability pa2
        INNER JOIN engagements e2 ON e2.engagement_id = pa2.engagement_id
        WHERE pa2.serviceproviderid = sp.serviceproviderid
          AND pa2.status = 'BOOKED'
          AND pa2.date = $5::date
          AND pa2.slot_start_epoch IS NOT NULL
          AND pa2.slot_end_epoch IS NOT NULL
          AND ${activeEngagementStatusSql("e2")}
          AND ${completedServiceDayConflictExclusionSql("pa2", "e2")}
          AND GREATEST(pa2.slot_start_epoch, $6::bigint) < LEAST(pa2.slot_end_epoch, $7::bigint)
          AND $8::bigint < LEAST(pa2.slot_end_epoch, $7::bigint)
          AND $9::bigint > GREATEST(pa2.slot_start_epoch, $6::bigint)
      )
    `,
    queryParams
  );

  return rows;
}

/**
 * Providers eligible for post-payment broadcast: matching role, within radius,
 * no overlapping BOOKED slot — schedule/timeslot is not required.
 */
export async function fetchBroadcastEligibleProviders(
  {
    latitude,
    longitude,
    serviceType,
    visitDateYmd,
    startEpoch,
    endEpoch,
    radiusKm = 30,
    genderPreference = null,
  },
  db = pool
) {
  const coords = normalizeBookingCoordinates(latitude, longitude);
  if (!coords) return [];

  const role = serviceTypeToRole(serviceType);
  const startEp = Number(startEpoch);
  const endEp = Number(endEpoch);
  if (!Number.isFinite(startEp) || startEp <= 0) return [];

  const slotEnd = Number.isFinite(endEp) && endEp > startEp ? endEp : startEp + 3600;
  const visitDate =
    visitDateYmd || dayjs.unix(startEp).tz("Asia/Kolkata").format("YYYY-MM-DD");
  const dayWindowStart = dayjs
    .tz(visitDate, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day")
    .unix();
  const dayWindowEnd = dayWindowStart + 86400;

  // Build gender filter SQL
  const genderFilterSql = genderPreference && genderPreference !== 'No Preference'
    ? `AND UPPER(TRIM(COALESCE(sp.gender, ''))) = UPPER($10)`
    : '';
  
  const queryParams = [
    coords.lat,
    coords.lng,
    role,
    Number(radiusKm),
    visitDate,
    dayWindowStart,
    dayWindowEnd,
    startEp,
    slotEnd,
  ];
  
  if (genderPreference && genderPreference !== 'No Preference') {
    queryParams.push(genderPreference);
  }

  const { rows } = await db.query(
    `
    SELECT sp.serviceproviderid, sp.latitude, sp.longitude, sp.gender
    FROM serviceprovider sp
    WHERE sp.isactive = true
      AND sp.latitude IS NOT NULL
      AND sp.longitude IS NOT NULL
      AND ${ON_DEMAND_ROLE_MATCH_SQL}
      ${genderFilterSql}
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
    queryParams
  );

  return rows;
}

/**
 * Notify providers within primary radius, then widen if none were reachable.
 * @returns {Promise<number>} count of providers notified
 */
export async function broadcastOnDemandToProviders({
  engagement,
  notifyProvider,
  primaryRadiusM = ON_DEMAND_NOTIFY_RADIUS_M,
  fallbackRadiusM = ON_DEMAND_NOTIFY_FALLBACK_RADIUS_M,
}) {
  if (!engagement?.latitude || !engagement?.longitude) return 0;

  const startEp = Number(engagement.start_epoch);
  const durationMin = Number(engagement.duration_minutes) || 60;
  const endEp = Number.isFinite(startEp) ? startEp + durationMin * 60 : null;
  
  // Extract gender preference from engagement
  const genderPreference = engagement.provider_gender_preference || 'No Preference';

  const broadcastParams = {
    latitude: engagement.latitude,
    longitude: engagement.longitude,
    serviceType: engagement.service_type,
    visitDateYmd: engagement.start_date,
    startEpoch: startEp,
    endEpoch: endEp,
    radiusKm: fallbackRadiusM / 1000,
    genderPreference,
  };

  const vacationPriority = await fetchVacationPriorityOnDemandProviders(broadcastParams);
  const general = await fetchBroadcastEligibleProviders(broadcastParams);

  const customerPoint = {
    latitude: Number(engagement.latitude),
    longitude: Number(engagement.longitude),
  };

  const vacationDistances = vacationPriority.map((p) => ({
    row: p,
    distance: geolib.getDistance(customerPoint, {
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
    }),
    vacationPriority: true,
  }));

  const generalDistances = general
    .filter((p) => !vacationPriority.some((v) => Number(v.serviceproviderid) === Number(p.serviceproviderid)))
    .map((p) => ({
      row: p,
      distance: geolib.getDistance(customerPoint, {
        latitude: Number(p.latitude),
        longitude: Number(p.longitude),
      }),
      vacationPriority: false,
    }));

  const distances = [...vacationDistances, ...generalDistances];

  // Log gender filtering results
  if (genderPreference && genderPreference !== 'No Preference') {
    console.log(`[Gender Filter] Engagement ${engagement.engagement_id}: filtering for ${genderPreference} providers. Found ${distances.length} eligible providers.`);
  }

  let notified = 0;
  const notifiedIds = new Set();

  const notifyWithin = async (maxM) => {
    for (const { row, distance } of distances) {
      if (distance > maxM) continue;
      const spid = Number(row.serviceproviderid);
      if (!Number.isFinite(spid) || spid < 1 || notifiedIds.has(spid)) continue;
      /* eslint-disable no-await-in-loop */
      const ok = await notifyProvider(row, distance);
      /* eslint-enable no-await-in-loop */
      if (ok) {
        notifiedIds.add(spid);
        notified += 1;
      }
    }
  };

  await notifyWithin(primaryRadiusM);
  if (notified === 0) {
    console.warn(
      `No providers within ${primaryRadiusM}m for engagement ${engagement.engagement_id} — widening to ${fallbackRadiusM}m`
    );
    await notifyWithin(fallbackRadiusM);
  }

  return notified;
}
