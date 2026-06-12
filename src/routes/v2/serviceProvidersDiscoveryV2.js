import express from "express";
import pool from "../../config/db.js";
import { activeEngagementStatusSql } from "../../services/providerAvailabilityOverlap.js";
import {
  customerHasSchedulableConflict,
  isActiveBlockingEngagement,
  rolesMatchForSearch,
} from "../../services/customerBookingOverlap.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

const router = express.Router();

function languageKnownToArray(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}


function epochInIST(dateStr, timeStr) {
  return dayjs
    .tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata")
    .unix();
}

function getDayWindowEpoch(dateStr) {
  return {
    start: epochInIST(dateStr, "00:00"),
    end: epochInIST(dateStr, "23:59")
  };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/** YYYY-MM-DD in Asia/Kolkata for DB dates / API strings (aligns with vacation + PA). */
function calendarYmdKolkata(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

/** True if `dateYmd` falls in [vacation_start_date, vacation_end_date] inclusive (IST calendar). */
function isDateInEngagementVacation(dateYmd, vacationStart, vacationEnd) {
  if (vacationStart == null || vacationEnd == null) return false;
  const d = calendarYmdKolkata(dateYmd);
  const a = calendarYmdKolkata(vacationStart);
  const b = calendarYmdKolkata(vacationEnd);
  if (!d || !a || !b) return false;
  return d >= a && d <= b;
}

function dateRangesOverlapYmd(rangeAStart, rangeAEnd, rangeBStart, rangeBEnd) {
  const a0 = calendarYmdKolkata(rangeAStart);
  const a1 = calendarYmdKolkata(rangeAEnd);
  const b0 = calendarYmdKolkata(rangeBStart);
  const b1 = calendarYmdKolkata(rangeBEnd);
  if (!a0 || !a1 || !b0 || !b1) return false;
  return a0 <= b1 && b0 <= a1;
}

function buildVacationAvailabilityPayload(row, searchStart, searchEnd) {
  const vacationStartDate = calendarYmdKolkata(row.vacation_start_date);
  const vacationEndDate = calendarYmdKolkata(row.vacation_end_date);
  if (!vacationStartDate || !vacationEndDate) return null;
  const leaveDays = Number(row.leave_days) || 0;
  if (leaveDays <= 0) return null;
  return {
    status: "ACTIVE",
    engagementId: row.engagement_id != null ? String(row.engagement_id) : null,
    leaveDays,
    vacationStartDate,
    vacationEndDate,
    engagementStartDate: calendarYmdKolkata(row.start_date),
    engagementEndDate: calendarYmdKolkata(row.end_date),
    overlapsSearchWindow: dateRangesOverlapYmd(
      vacationStartDate,
      vacationEndDate,
      searchStart,
      searchEnd
    ),
  };
}

async function fetchActiveVacationByProvider(providerIds) {
  if (!providerIds?.length) return new Map();
  const res = await pool.query(
    `
    SELECT DISTINCT ON (e.serviceproviderid)
      e.serviceproviderid,
      e.engagement_id,
      e.leave_days,
      e.vacation_start_date,
      e.vacation_end_date,
      e.start_date,
      e.end_date
    FROM engagements e
    WHERE e.serviceproviderid = ANY($1::bigint[])
      AND e.active = true
      AND COALESCE(e.leave_days, 0) > 0
      AND e.vacation_start_date IS NOT NULL
      AND e.vacation_end_date IS NOT NULL
      AND UPPER(COALESCE(e.engagement_status, '')) NOT IN (
        'CANCELLED', 'COMPLETED', 'CLOSED', 'EXPIRED'
      )
      AND UPPER(COALESCE(e.task_status, 'NOT_STARTED')) NOT IN (
        'CANCELLED', 'COMPLETED'
      )
    ORDER BY
      e.serviceproviderid,
      e.end_date DESC NULLS LAST,
      e.created_at DESC NULLS LAST
    `,
    [providerIds]
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(String(row.serviceproviderid), row);
  }
  return map;
}

/**
 * Daily busy intervals from this customer's existing engagement with this provider,
 * intersected with the search range. Ensures overlap checks match the booked wall-clock
 * window when provider_availability rows use month-spanning epochs that normalize away
 * from the preferred slot.
 */
function previousEngagementBusyIntervals(
  prev,
  rangeStartStr,
  rangeEndStr,
  roleNorm,
  fallbackDurationSec
) {
  if (!isActiveBlockingEngagement(prev)) return [];
  if (!rolesMatchForSearch(prev.serviceType, roleNorm)) return [];

  const startEp = Number(prev.startEpoch);
  let timeStr;
  if (Number.isFinite(startEp)) {
    timeStr = dayjs.unix(startEp).tz("Asia/Kolkata").format("HH:mm");
  } else if (prev.startDate != null) {
    timeStr = dayjs(prev.startDate).tz("Asia/Kolkata").format("HH:mm");
  } else {
    return [];
  }
  let blockDurSec = fallbackDurationSec;
  const dm = prev.durationMinutes;
  if (dm != null && dm >= 1 && dm <= 24 * 60) {
    blockDurSec = dm * 60;
  }

  const engStart = dayjs(prev.startDate).tz("Asia/Kolkata").startOf("day");
  const engEnd = dayjs(prev.endDate).tz("Asia/Kolkata").startOf("day");
  const reqStart = dayjs.tz(rangeStartStr, "YYYY-MM-DD", "Asia/Kolkata").startOf("day");
  const reqEnd = dayjs.tz(rangeEndStr, "YYYY-MM-DD", "Asia/Kolkata").startOf("day");

  if (engEnd.isBefore(reqStart, "day") || engStart.isAfter(reqEnd, "day")) {
    return [];
  }

  const from = engStart.isAfter(reqStart) ? engStart : reqStart;
  const to = engEnd.isBefore(reqEnd) ? engEnd : reqEnd;

  const out = [];
  let cursor = from.clone();
  while (!cursor.isAfter(to, "day")) {
    const dateStr = cursor.format("YYYY-MM-DD");
    // Match PA + engagement fallback: vacation days are not busy for the SP.
    if (isDateInEngagementVacation(dateStr, prev.vacationStartDate, prev.vacationEndDate)) {
      cursor = cursor.add(1, "day");
      continue;
    }
    const blockStart = epochInIST(dateStr, timeStr);
    const blockEnd = blockStart + blockDurSec;
    out.push({
      slot_start_epoch: blockStart,
      slot_end_epoch: blockEnd,
      _fromCustomerPriorEngagement: true,
    });
    cursor = cursor.add(1, "day");
  }
  return out;
}

function engagementOverlapsSearchWindow(prev, rangeStartStr, rangeEndStr) {
  if (!prev) return false;
  const engStart = dayjs(prev.startDate).tz("Asia/Kolkata").startOf("day");
  const engEnd = dayjs(prev.endDate).tz("Asia/Kolkata").startOf("day");
  const reqStart = dayjs.tz(rangeStartStr, "YYYY-MM-DD", "Asia/Kolkata").startOf(
    "day"
  );
  const reqEnd = dayjs.tz(rangeEndStr, "YYYY-MM-DD", "Asia/Kolkata").startOf(
    "day"
  );
  return (
    !engEnd.isBefore(reqStart, "day") && !engStart.isAfter(reqEnd, "day")
  );
}

function calendarDayInPriorEngagement(prev, dateStr) {
  if (!prev) return false;
  const d = dayjs.tz(dateStr, "YYYY-MM-DD", "Asia/Kolkata").startOf("day");
  const engStart = dayjs(prev.startDate).tz("Asia/Kolkata").startOf("day");
  const engEnd = dayjs(prev.endDate).tz("Asia/Kolkata").startOf("day");
  return !d.isBefore(engStart, "day") && !d.isAfter(engEnd, "day");
}

/**
 * Busy interval for one provider_availability row, clipped to the IST calendar day of `pa.date`.
 * Matches V2 create overlap: GREATEST(slot_start_epoch, dayStart) < LEAST(slot_end_epoch, dayEnd).
 */
function paBookedClippedToRowDate(dateStr, slotStartEpoch, slotEndEpoch) {
  const start = Number(slotStartEpoch);
  const end = Number(slotEndEpoch);
  if (!(start < end)) return null;
  const dayStart = epochInIST(dateStr, "00:00");
  const dayEnd = dayStart + 86400;
  const clipStart = Math.max(start, dayStart);
  const clipEnd = Math.min(end, dayEnd);
  if (clipStart < clipEnd) {
    return { slot_start_epoch: clipStart, slot_end_epoch: clipEnd };
  }
  return null;
}

/** pg TIME / string → HH:mm for epochInIST */
function normalizeTimeForEpoch(t) {
  if (t == null) return "00:00";
  if (t instanceof Date) {
    return `${String(t.getUTCHours()).padStart(2, "0")}:${String(
      t.getUTCMinutes()
    ).padStart(2, "0")}`;
  }
  const s = String(t).trim();
  if (/^\d{1,2}:\d{2}:\d{2}/.test(s)) return s.slice(0, 5);
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(":");
    return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  }
  return s.slice(0, 5);
}

/**
 * Same shape as provider_weekly_slots rows (day_of_week 0–6 Sun–Sat, HH:mm).
 * Mirrors onboarding convertTimeslotString: each range applies to every weekday.
 */
function weeklySlotsFromTimeslotString(timeslot) {
  if (!timeslot || typeof timeslot !== "string") return [];
  const ranges = timeslot.split(",");
  const slots = [];
  for (let day = 0; day <= 6; day++) {
    for (const range of ranges) {
      const [start, end] = range.trim().split("-");
      if (!start || !end || start.trim() >= end.trim()) continue;
      slots.push({
        day_of_week: day,
        slot_start: start.trim().slice(0, 5),
        slot_end: end.trim().slice(0, 5)
      });
    }
  }
  return slots;
}

function isValidISODate(dateStr) {
  if (typeof dateStr !== "string") return false;
  return dayjs(dateStr, "YYYY-MM-DD", true).isValid();
}

function isValidTimeHHmm(timeStr) {
  if (typeof timeStr !== "string") return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr);
}

/** Max rows per page for /nearby-monthly (query or body `limit`). */
const NEARBY_MONTHLY_PAGE_LIMIT_MAX = 200;

/**
 * `page` / `limit` from query string override the same keys in the JSON body when present.
 */
function parseNearbyMonthlyPagination(query, body) {
  const q = query || {};
  const b = body || {};
  const hasQueryPage =
    q.page != null && String(q.page).trim() !== "";
  const hasQueryLimit =
    q.limit != null && String(q.limit).trim() !== "";
  const rawPage = hasQueryPage ? q.page : b.page;
  const rawLimit = hasQueryLimit ? q.limit : b.limit;

  let page = Number(rawPage);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.floor(page);

  let limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(NEARBY_MONTHLY_PAGE_LIMIT_MAX, Math.floor(limit));

  return { page, limit };
}

function getAge(dobString) {
  const today = new Date();
  const dob = new Date(dobString);
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  const dayDiff = today.getDate() - dob.getDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age--;
  return age;
}




/**
 * @swagger
 * /v2/service-providers/nearby-monthly:
 *   post:
 *     summary: Monthly nearby provider discovery (V2)
 *     description: >
 *       Returns providers within radius ranked by full monthly availability for a date range
 *       and preferred daily start time. Bookings use `provider_availability` (BOOKED) plus
 *       MONTHLY/SHORT_TERM engagements; days inside `engagements.vacation_start_date`…`vacation_end_date`
 *       are excluded from that engagement-derived busy grid so vacation shows as available.
 *     tags:
 *       - Service providers V2
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 10 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - lat
 *               - lng
 *               - role
 *               - startDate
 *               - endDate
 *               - preferredStartTime
 *             properties:
 *               lat: { type: number }
 *               lng: { type: number }
 *               role: { type: string }
 *               radius: { type: number, default: 10 }
 *               startDate: { type: string, format: date }
 *               endDate: { type: string, format: date }
 *               preferredStartTime: { type: string, example: "07:00" }
 *               serviceDurationMinutes: { type: integer }
 *               customerID: { type: integer }
 *               customerId: { type: integer }
 *     responses:
 *       "200":
 *         description: Paginated provider list with monthly availability summary
 *       "400":
 *         description: Missing or invalid parameters
 *       "500":
 *         description: Server error
 */
router.post("/nearby-monthly", async (req, res) => {
  try {
    const b = req.body || {};
    const q = req.query || {};
    const {
      lat,
      lng,
      role,
      radius = 10,
      startDate,
      endDate,
      preferredStartTime,
      serviceDurationMinutes
    } = b;
    const customerID = b.customerID ?? q.customerID;
    const customerId = b.customerId ?? q.customerId;

    const { page, limit } = parseNearbyMonthlyPagination(q, b);

    if (
      !lat ||
      !lng ||
      !role ||
      !startDate ||
      !endDate ||
      !preferredStartTime ||
      !serviceDurationMinutes
    ) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!isValidISODate(startDate) || !isValidISODate(endDate)) {
      return res.status(400).json({
        message: "Invalid date format. Use YYYY-MM-DD for startDate and endDate.",
      });
    }

    if (!isValidTimeHHmm(preferredStartTime)) {
      return res.status(400).json({
        message: "Invalid preferredStartTime. Use HH:mm (24-hour), e.g. 08:00.",
      });
    }

    if (dayjs(endDate).isBefore(dayjs(startDate))) {
      return res.status(400).json({
        message: "endDate must be on/after startDate.",
      });
    }

    const roleSearchNorm = String(role).trim();

    let latNum = Number(lat);
    let lngNum = Number(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({
        message: "Invalid lat/lng. Send finite numbers (e.g. customer latitude/longitude).",
      });
    }
    if (Math.abs(latNum) > 90 && Math.abs(lngNum) <= 90) {
      [latNum, lngNum] = [lngNum, latNum];
    }

    const customerIdInput = customerID ?? customerId;
    const customerIdRaw =
      customerIdInput != null && customerIdInput !== ""
        ? Number(customerIdInput)
        : null;
    const hasCustomerID =
      customerIdRaw != null && !Number.isNaN(customerIdRaw);

    /* ---------- STEP 1: Nearby Providers ---------- */
    const providersRes = await pool.query(
      `
      SELECT
        sp."serviceproviderid",
        sp."firstName",
        sp."lastName",
        sp."gender",
        sp."experience",
        sp."rating",
        sp."profilepic",
        sp."mobileNo",
        sp."emailId",
        sp."diet",
        sp."cookingSpeciality",
        sp."languageknown",
        sp."locality",
        sp."location",
        sp."pincode",
        sp."latitude",
        sp."longitude",
        sp."dob",
        sp."timeslot",
        sp."housekeepingRole",
        (
          6371 * acos(
            cos(radians($1)) * cos(radians(sp."latitude")) *
            cos(radians(sp."longitude") - radians($2)) +
            sin(radians($1)) * sin(radians(sp."latitude"))
          )
        ) AS distance_km
      FROM "serviceprovider" sp
      WHERE sp."isactive" = true
        AND (
          EXISTS (
            SELECT 1
            FROM serviceprovider_roles r
            WHERE r.serviceproviderid = sp."serviceproviderid"
              AND LOWER(TRIM(r.role::text)) = LOWER(TRIM($3::text))
          )
          OR (
            NOT EXISTS (
              SELECT 1
              FROM serviceprovider_roles r2
              WHERE r2.serviceproviderid = sp."serviceproviderid"
            )
            AND LOWER(TRIM(COALESCE(sp."housekeepingRole", ''::text))) = LOWER(TRIM($3::text))
          )
          OR (
            LOWER(TRIM(COALESCE(sp."housekeepingRole", ''::text))) = LOWER(TRIM($3::text))
            AND NOT EXISTS (
              SELECT 1
              FROM serviceprovider_roles r3
              WHERE r3.serviceproviderid = sp."serviceproviderid"
                AND LOWER(TRIM(r3.role::text)) = LOWER(TRIM($3::text))
            )
          )
        )
        AND (
          6371 * acos(
            cos(radians($1)) * cos(radians(sp."latitude")) *
            cos(radians(sp."longitude") - radians($2)) +
            sin(radians($1)) * sin(radians(sp."latitude"))
          )
        ) <= $4
      ORDER BY distance_km ASC
      `,
      [latNum, lngNum, roleSearchNorm, radius]
    );

    if (!providersRes.rows.length) {
      return res.json({ count: 0, providers: [] });
    }

    const providerIds = providersRes.rows.map(p => p.serviceproviderid);
    const activeVacationByProvider = await fetchActiveVacationByProvider(providerIds);

    const rolesRes = await pool.query(
      `
      SELECT serviceproviderid, role
      FROM serviceprovider_roles
      WHERE serviceproviderid = ANY($1::bigint[])
      ORDER BY role
      `,
      [providerIds]
    );
    const rolesBySpId = {};
    for (const row of rolesRes.rows) {
      const id = String(row.serviceproviderid);
      rolesBySpId[id] ??= [];
      if (row.role != null && String(row.role).trim() !== "") {
        rolesBySpId[id].push(String(row.role).trim());
      }
    }

    /* ---------- Previous bookings for this customer (optional) ---------- */
    let previousBookingByProvider = new Map();
    if (hasCustomerID) {
      const prevRes = await pool.query(
        `
        SELECT DISTINCT ON (e."serviceproviderid")
          e."engagement_id" AS "engagementId",
          e."serviceproviderid" AS "serviceproviderid",
          e."booking_type" AS "bookingType",
          e."service_type" AS "serviceType",
          e."start_date" AS "startDate",
          e."end_date" AS "endDate",
          e."start_epoch" AS "startEpoch",
          e."duration_minutes" AS "durationMinutes",
          e."vacation_start_date" AS "vacationStartDate",
          e."vacation_end_date" AS "vacationEndDate",
          e."leave_days" AS "leaveDays",
          e."engagement_status" AS "engagementStatus",
          e."assignment_status" AS "assignmentStatus",
          e."task_status" AS "taskStatus",
          e."active" AS "active",
          e."base_amount" AS "baseAmount",
          e."created_at" AS "createdAt"
        FROM engagements e
        WHERE e."customerid" = $1
          AND e."serviceproviderid" = ANY($2::bigint[])
          AND e.active = true
          AND UPPER(COALESCE(e.engagement_status, '')) NOT IN (
            'CANCELLED', 'COMPLETED', 'CLOSED', 'EXPIRED'
          )
          AND UPPER(COALESCE(e.task_status, 'NOT_STARTED')) NOT IN (
            'CANCELLED', 'COMPLETED'
          )
        ORDER BY
          e."serviceproviderid",
          e."end_date" DESC NULLS LAST,
          e."created_at" DESC NULLS LAST
        `,
        [customerIdRaw, providerIds]
      );
      for (const row of prevRes.rows) {
        const id = String(row.serviceproviderid);
        if (previousBookingByProvider.has(id)) continue;
        previousBookingByProvider.set(id, {
          engagementId: row.engagementId != null ? String(row.engagementId) : null,
          bookingType: row.bookingType,
          serviceType: row.serviceType,
          startDate: row.startDate,
          endDate: row.endDate,
          startEpoch: row.startEpoch != null ? Number(row.startEpoch) : null,
          durationMinutes:
            row.durationMinutes != null ? Number(row.durationMinutes) : null,
          vacationStartDate: row.vacationStartDate,
          vacationEndDate: row.vacationEndDate,
          leaveDays: row.leaveDays != null ? Number(row.leaveDays) : 0,
          engagementStatus: row.engagementStatus,
          assignmentStatus: row.assignmentStatus,
          taskStatus: row.taskStatus,
          active: row.active,
          baseAmount: row.baseAmount != null ? Number(row.baseAmount) : null,
          createdAt: row.createdAt
        });
      }
    }

    /* ---------- STEP 2: Fetch Weekly Slots ---------- */
    const weeklySlotsRes = await pool.query(
      `
      SELECT serviceproviderid, day_of_week, slot_start, slot_end
      FROM provider_weekly_slots
      WHERE serviceproviderid = ANY($1)
      `,
      [providerIds]
    );

    const weeklySlotsByProvider = {};
    /** @type {Record<string, 'provider_weekly_slots' | 'timeslot' | 'none'>} */
    const weeklySlotSourceByProvider = {};
    for (const row of weeklySlotsRes.rows) {
      const sid = String(row.serviceproviderid);
      weeklySlotSourceByProvider[sid] = "provider_weekly_slots";
      weeklySlotsByProvider[sid] ??= [];
      weeklySlotsByProvider[sid].push({
        day_of_week: Number(row.day_of_week),
        slot_start: normalizeTimeForEpoch(row.slot_start),
        slot_end: normalizeTimeForEpoch(row.slot_end)
      });
    }

    for (const p of providersRes.rows) {
      const id = String(p.serviceproviderid);
      const existing = weeklySlotsByProvider[id];
      if (!existing || existing.length === 0) {
        const derived = weeklySlotsFromTimeslotString(p.timeslot);
        if (derived.length > 0) {
          weeklySlotsByProvider[id] = derived;
          weeklySlotSourceByProvider[id] = "timeslot";
        }
      }
    }

    for (const p of providersRes.rows) {
      const id = String(p.serviceproviderid);
      const slots = weeklySlotsByProvider[id];
      if (!weeklySlotSourceByProvider[id]) {
        weeklySlotSourceByProvider[id] =
          slots && slots.length > 0 ? "provider_weekly_slots" : "none";
      }
    }

    /* ---------- STEP 3: Fetch Bookings ---------- */
    const bookingsRes = await pool.query(
      `
      SELECT
        pa.serviceproviderid,
        pa.date::text AS "dateStr",
        pa.slot_start_epoch,
        pa.slot_end_epoch
      FROM provider_availability pa
      INNER JOIN engagements e ON e.engagement_id = pa.engagement_id
      WHERE
        pa.serviceproviderid = ANY($1)
        AND pa.status = 'BOOKED'
        AND pa.date BETWEEN $2::date AND $3::date
        AND pa.slot_start_epoch IS NOT NULL
        AND pa.slot_end_epoch IS NOT NULL
        AND ${activeEngagementStatusSql("e")}
      `,
      [providerIds, startDate, endDate]
    );

    const engagementsRes = await pool.query(
      `
      SELECT
        e.engagement_id,
        e.serviceproviderid,
        e.booking_type,
        e.start_date,
        e.end_date,
        e.start_epoch,
        e.end_epoch,
        e.duration_minutes,
        e.vacation_start_date,
        e.vacation_end_date
      FROM engagements e
      WHERE
        e.serviceproviderid = ANY($1)
        AND e.serviceproviderid IS NOT NULL
        AND e.active = true
        AND e.start_date <= $3::date
        AND e.end_date >= $2::date
        AND e.booking_type IN ('MONTHLY', 'SHORT_TERM', 'ON_DEMAND')
        AND ${activeEngagementStatusSql("e")}
        AND (
          e.service_type IS NULL
          OR LOWER(TRIM(e.service_type::text)) = LOWER(TRIM($4::text))
          OR (
            LOWER(TRIM($4::text)) LIKE '%cook%'
            AND LOWER(TRIM(e.service_type::text)) LIKE '%cook%'
          )
        )
      `,
      [providerIds, startDate, endDate, roleSearchNorm]
    );

    /** (sp, YYYY-MM-DD) in Asia/Kolkata — contract vacation from engagements (source of truth for "no visit" days) */
    const engagementVacationBySpAndDate = new Set();
    {
      const rStart = dayjs
        .tz(calendarYmdKolkata(startDate), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");
      const rEnd = dayjs
        .tz(calendarYmdKolkata(endDate), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");
      for (const e of engagementsRes.rows) {
        if (e.booking_type === "ON_DEMAND") continue;
        const spid = String(e.serviceproviderid);
        for (
          let c = rStart.clone();
          !c.isAfter(rEnd, "day");
          c = c.add(1, "day")
        ) {
          const ds = c.format("YYYY-MM-DD");
          if (isDateInEngagementVacation(ds, e.vacation_start_date, e.vacation_end_date)) {
            engagementVacationBySpAndDate.add(`${spid}:${ds}`);
          }
        }
      }
    }

    /** If PA is FREE (e.g. vacation) for (sp, engagement, day), we must not add a synthetic block from the engagement. */
    const paFreeRes = await pool.query(
      `
      SELECT
        pa.serviceproviderid,
        pa.engagement_id,
        pa.date::text AS "dateStr"
      FROM provider_availability pa
      WHERE
        pa.serviceproviderid = ANY($1)
        AND LOWER(TRIM(COALESCE(pa.status::text, ''))) = 'free'
        AND pa.date BETWEEN $2::date AND $3::date
        AND pa.engagement_id IS NOT NULL
      `,
      [providerIds, startDate, endDate]
    );
    /** (sp, engagement, date) — skip synthetic busy for that day */
    const paFreeEngagementDay = new Set();
    /** (sp, date) — that calendar day the SP is not on a paid visit in PA (vacation / freed); never treat as "BOOKED" at the visit window */
    const paFreeBySpAndCalendarDate = new Set();
    for (const f of paFreeRes.rows) {
      const d = f.dateStr.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const spK = String(f.serviceproviderid);
      paFreeEngagementDay.add(`${spK}:${String(f.engagement_id)}:${d}`);
      paFreeBySpAndCalendarDate.add(`${spK}:${d}`);
    }

    const spDayClearedForVisit = new Set();
    for (const k of paFreeBySpAndCalendarDate) {
      spDayClearedForVisit.add(k);
    }
    for (const k of engagementVacationBySpAndDate) {
      spDayClearedForVisit.add(k);
    }

    /* Synthetic MONTHLY/SHORT uses engagementsRes + PA (already loaded) */

    const bookingsByProvider = {};
    const paBookedCountBySp = {};
    for (const b of bookingsRes.rows) {
      const spid = String(b.serviceproviderid);
      paBookedCountBySp[spid] = (paBookedCountBySp[spid] || 0) + 1;
      const clipped = paBookedClippedToRowDate(
        b.dateStr,
        b.slot_start_epoch,
        b.slot_end_epoch
      );
      if (!clipped) continue;
      bookingsByProvider[spid] ??= [];
      bookingsByProvider[spid].push(clipped);
    }

    const engMonthlyShortTermBySp = {};
    const engOnDemandBySp = {};

    for (const e of engagementsRes.rows) {
      const spid = String(e.serviceproviderid);

      if (e.booking_type === "ON_DEMAND") {
        engOnDemandBySp[spid] = (engOnDemandBySp[spid] || 0) + 1;
        const ss = Number(e.start_epoch);
        const ee = Number(e.end_epoch);
        if (!Number.isNaN(ss) && !Number.isNaN(ee) && ee > ss) {
          bookingsByProvider[spid] ??= [];
          bookingsByProvider[spid].push({
            slot_start_epoch: ss,
            slot_end_epoch: ee
          });
        }
        continue;
      }

      engMonthlyShortTermBySp[spid] = (engMonthlyShortTermBySp[spid] || 0) + 1;
      const timeStr = dayjs
        .unix(Number(e.start_epoch))
        .tz("Asia/Kolkata")
        .format("HH:mm");
      const durMin =
        e.duration_minutes != null &&
        e.duration_minutes >= 1 &&
        e.duration_minutes <= 24 * 60
          ? e.duration_minutes
          : 60;
      const durationSec = durMin * 60;

      const engStartDay = dayjs
        .tz(calendarYmdKolkata(e.start_date), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");
      const engEndDay = dayjs
        .tz(calendarYmdKolkata(e.end_date), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");
      const rangeStartDay = dayjs
        .tz(calendarYmdKolkata(startDate), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");
      const rangeEndDay = dayjs
        .tz(calendarYmdKolkata(endDate), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");

      const fromDay = engStartDay.isAfter(rangeStartDay) ? engStartDay : rangeStartDay;
      const toDay = engEndDay.isBefore(rangeEndDay) ? engEndDay : rangeEndDay;

      bookingsByProvider[spid] ??= [];
      const engIdStr = e.engagement_id != null ? String(e.engagement_id) : "";
      let dayCursor = fromDay.clone();
      while (!dayCursor.isAfter(toDay, "day")) {
        const dateStr = dayCursor.format("YYYY-MM-DD");
        const isPaFreeThisDay =
          engIdStr &&
          paFreeEngagementDay.has(`${spid}:${engIdStr}:${dateStr}`);
        if (isPaFreeThisDay) {
          dayCursor = dayCursor.add(1, "day");
          continue;
        }
        if (
          isDateInEngagementVacation(
            dateStr,
            e.vacation_start_date,
            e.vacation_end_date
          )
        ) {
          dayCursor = dayCursor.add(1, "day");
          continue;
        }
        const slotStart = epochInIST(dateStr, timeStr);
        const slotEnd = slotStart + durationSec;
        bookingsByProvider[spid].push({
          slot_start_epoch: slotStart,
          slot_end_epoch: slotEnd
        });
        dayCursor = dayCursor.add(1, "day");
      }
    }

    /* ---------- STEP 4: Monthly Evaluation ---------- */
    const durationSec = serviceDurationMinutes * 60;
    const evaluatedProviders = [];

    for (const p of providersRes.rows) {
      const pidKey = String(p.serviceproviderid);
      const providerWeeklySlots = weeklySlotsByProvider[pidKey] || [];

      const baseBookings = bookingsByProvider[pidKey] || [];
      const prevForSp = hasCustomerID
        ? previousBookingByProvider.get(pidKey)
        : null;

      const fromPrevEngagement = previousEngagementBusyIntervals(
        prevForSp,
        startDate,
        endDate,
        roleSearchNorm,
        durationSec
      );
      let providerBookingsMerged = [...baseBookings, ...fromPrevEngagement];
      if (spDayClearedForVisit.size) {
        providerBookingsMerged = providerBookingsMerged.filter((b) => {
          if (b._fromCustomerPriorEngagement) return true;
          const t = Number(b.slot_start_epoch);
          if (!Number.isFinite(t)) return true;
          const dKey = dayjs.unix(t).tz("Asia/Kolkata").format("YYYY-MM-DD");
          return !spDayClearedForVisit.has(`${pidKey}:${dKey}`);
        });
      }

      let totalDays = 0;
      let daysAtPreferredTime = 0;
      let daysWithDifferentTime = 0;
      let unavailableDays = 0;
      const exceptions = [];

      const rangeEvalStart = dayjs
        .tz(calendarYmdKolkata(startDate), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");
      const rangeEvalEnd = dayjs
        .tz(calendarYmdKolkata(endDate), "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day");

      let clearedContractVisitDaysInRange = 0;
      for (
        let c0 = rangeEvalStart.clone();
        !c0.isAfter(rangeEvalEnd, "day");
        c0 = c0.add(1, "day")
      ) {
        if (spDayClearedForVisit.has(`${pidKey}:${c0.format("YYYY-MM-DD")}`)) {
          clearedContractVisitDaysInRange++;
        }
      }

      for (
        let evDay = rangeEvalStart.clone();
        !evDay.isAfter(rangeEvalEnd, "day");
        evDay = evDay.add(1, "day")
      ) {
        totalDays++;

        const dateStr = evDay.format("YYYY-MM-DD");
        const dow = evDay.day();

        const todaysSlots = providerWeeklySlots.filter(
          s => s.day_of_week === dow
        );

        if (!todaysSlots.length) {
          unavailableDays++;
          exceptions.push({
            date: dateStr,
            reason: "NO_WEEKLY_SLOT_DEFINED",
            suggestedTime: null
          });
          continue;
        }

        /* Contract not running this calendar day (vacation / PA FREE) — skip generic BOOKED checks */
        if (spDayClearedForVisit.has(`${pidKey}:${dateStr}`)) {
          const preferredEpochEarly = epochInIST(dateStr, preferredStartTime);
          const isInside = todaysSlots.some((slot) => {
            const s0 = epochInIST(dateStr, slot.slot_start);
            const s1 = epochInIST(dateStr, slot.slot_end);
            return (
              preferredEpochEarly >= s0 &&
              preferredEpochEarly + durationSec <= s1
            );
          });
          if (isInside) {
            daysAtPreferredTime++;
          } else {
            daysWithDifferentTime++;
            exceptions.push({
              date: dateStr,
              reason: "OUTSIDE_WORKING_HOURS",
              suggestedTime: todaysSlots[0].slot_start
            });
          }
          continue;
        }

        const providerBookings = providerBookingsMerged;

        const preferredEpoch = epochInIST(dateStr, preferredStartTime);

        // console.log(`Evaluating Provider ${pidKey} on ${dateStr} with preferred time ${preferredStartTime}`);

        /* ---------- 1️⃣ Check Working Hours ---------- */
        const isInsideWorkingSlot = todaysSlots.some(slot => {
          const slotStartEpoch = epochInIST(dateStr, slot.slot_start);
          const slotEndEpoch = epochInIST(dateStr, slot.slot_end);

          return (
            preferredEpoch >= slotStartEpoch &&
            preferredEpoch + durationSec <= slotEndEpoch
          );
        });

        if (!isInsideWorkingSlot) {
          daysWithDifferentTime++;
          exceptions.push({
            date: dateStr,
            reason: "OUTSIDE_WORKING_HOURS",
            suggestedTime: todaysSlots[0].slot_start
          });
          continue;
        }

        /* Same customer + provider already engaged for another service in this period (e.g. MAID vs NANNY search) */
        if (hasCustomerID && prevForSp && isActiveBlockingEngagement(prevForSp)) {
          if (
            !rolesMatchForSearch(prevForSp.serviceType, roleSearchNorm) &&
            engagementOverlapsSearchWindow(prevForSp, startDate, endDate) &&
            calendarDayInPriorEngagement(prevForSp, dateStr)
          ) {
            daysWithDifferentTime++;
            exceptions.push({
              date: dateStr,
              reason: "EXISTING_CUSTOMER_OTHER_SERVICE",
              suggestedTime: null,
            });
            continue;
          }
        }

        /* ---------- 2️⃣ Check Booking Conflict ---------- */
        const prefEnd = preferredEpoch + durationSec;
        const blockingPreferred = providerBookings.filter(b =>
          overlaps(
            preferredEpoch,
            prefEnd,
            b.slot_start_epoch,
            b.slot_end_epoch
          )
        );
        const blockedByCustomerPriorEngagement = blockingPreferred.some(
          b => b._fromCustomerPriorEngagement
        );

        if (blockingPreferred.length === 0) {
          daysAtPreferredTime++;
          continue;
        }

        /* Customer already has this SP for this role on these dates — show in list, not fullyAvailable */
        if (blockedByCustomerPriorEngagement) {
          daysWithDifferentTime++;
          exceptions.push({
            date: dateStr,
            reason: "EXISTING_CUSTOMER_BOOKING",
            suggestedTime: null,
          });
          continue;
        }

        /* ---------- 3️⃣ Find Alternate Slot (other customers / generic BOOKED) ---------- */
        let alternate = null;

        for (const slot of todaysSlots) {
          const startHour = parseInt(slot.slot_start.split(":")[0]);
          const endHour = parseInt(slot.slot_end.split(":")[0]);

          for (let h = startHour; h < endHour; h++) {
            const epoch = epochInIST(
              dateStr,
              String(h).padStart(2, "0") + ":00"
            );

            const blocked = providerBookings.some(b =>
              overlaps(
                epoch,
                epoch + durationSec,
                b.slot_start_epoch,
                b.slot_end_epoch
              )
            );

            if (!blocked) {
              alternate = `${String(h).padStart(2, "0")}:00`;
              break;
            }
          }

          if (alternate) break;
        }

        if (alternate) {
          daysWithDifferentTime++;
          exceptions.push({
            date: dateStr,
            reason: "BOOKED",
            suggestedTime: alternate
          });
        } else {
          unavailableDays++;
          exceptions.push({
            date: dateStr,
            reason: "FULLY_BOOKED",
            suggestedTime: null
          });
        }
      }
      

      const providerRow = {
        serviceproviderid: p.serviceproviderid,
        firstName: p.firstName,
        lastName: p.lastName,
        gender: p.gender,
        experience: p.experience,
        rating: p.rating,
        diet: p.diet,
        cookingSpeciality: p.cookingSpeciality,
        languageKnown: languageKnownToArray(p.languageknown),
        /** @deprecated comma-separated from DB; prefer `languageKnown` array */
        languageknown: p.languageknown ?? null,
        locality: p.locality,
        location: p.location,
        pincode: p.pincode,
        latitude: p.latitude,
        longitude: p.longitude,
        age: p.dob != null ? getAge(p.dob) : null,
        housekeepingRole: p.housekeepingRole,
        housekeepingRoles: (() => {
          const fromJunction = rolesBySpId[pidKey];
          if (fromJunction?.length) {
            const seen = new Set(
              fromJunction.map((r) => String(r).trim().toLowerCase())
            );
            const out = [...fromJunction];
            const leg = p.housekeepingRole != null ? String(p.housekeepingRole).trim() : "";
            if (leg && !seen.has(leg.toLowerCase())) {
              out.push(p.housekeepingRole);
            }
            return out;
          }
          return p.housekeepingRole ? [String(p.housekeepingRole).trim()] : [];
        })(),
        distance_km: Number(p.distance_km.toFixed(2)),
        distanceKm: Number(p.distance_km.toFixed(2)),
        bestMatch: false,
        hasCustomerOverlap:
          hasCustomerID &&
          customerHasSchedulableConflict(
            prevForSp,
            startDate,
            endDate,
            preferredStartTime,
            durationSec,
            roleSearchNorm
          ),
        monthlyAvailability: {
          preferredTime: preferredStartTime,
          fullyAvailable:
            unavailableDays === 0 && daysWithDifferentTime === 0,
          summary: {
            totalDays,
            daysAtPreferredTime,
            daysWithDifferentTime,
            unavailableDays
          },
          exceptions
        },
        availabilityFromDb: {
          weeklySlotsSource:
            weeklySlotSourceByProvider[pidKey] || "none",
          bookedRowsProviderAvailabilityInRange:
            paBookedCountBySp[pidKey] || 0,
          engagementsMonthlyOrShortTermInRange:
            engMonthlyShortTermBySp[pidKey] || 0,
          engagementsOnDemandInRange:
            engOnDemandBySp[pidKey] || 0,
          mergedBookedIntervalsUsedForOverlapCheck: providerBookingsMerged.length,
          /** Search-window days where no contract visit applies (engagement vacation + PA FREE). Expect 22 for 126 on 5/1–5/22 when `engagements` has vacation. */
          clearedContractVisitDaysInRange
        },
        previouslyBooked: false,
        previousBookingDetails: null,
        vacationAvailability: (() => {
          const vacRow = activeVacationByProvider.get(pidKey);
          return vacRow
            ? buildVacationAvailabilityPayload(vacRow, startDate, endDate)
            : null;
        })(),
      };

      if (hasCustomerID) {
        const pid = pidKey;
        const prev = previousBookingByProvider.get(pid);
        providerRow.previouslyBooked = !!prev;
        if (prev) {
          const {
            startEpoch: _se,
            durationMinutes: _dm,
            ...prevForApi
          } = prev;
          providerRow.previousBookingDetails = prevForApi;
          if (
            !providerRow.vacationAvailability &&
            prev.leaveDays > 0 &&
            prev.vacationStartDate &&
            prev.vacationEndDate
          ) {
            providerRow.vacationAvailability = {
              status: "ACTIVE",
              engagementId: prev.engagementId,
              leaveDays: prev.leaveDays,
              vacationStartDate: calendarYmdKolkata(prev.vacationStartDate),
              vacationEndDate: calendarYmdKolkata(prev.vacationEndDate),
              engagementStartDate: calendarYmdKolkata(prev.startDate),
              engagementEndDate: calendarYmdKolkata(prev.endDate),
              overlapsSearchWindow: dateRangesOverlapYmd(
                prev.vacationStartDate,
                prev.vacationEndDate,
                startDate,
                endDate
              ),
            };
          }
        }
      }

      evaluatedProviders.push(providerRow);
    }


    /* ---------- STEP 5: Group & Rank ---------- */
    const available = evaluatedProviders.filter(
      p => p.monthlyAvailability.fullyAvailable
    );

    const notAvailable = evaluatedProviders.filter(
      p => !p.monthlyAvailability.fullyAvailable
    );

    available.sort((a, b) => a.distance_km - b.distance_km);

    const ordered = [...available, ...notAvailable];

    // When a customer is searching, prioritize providers they booked before.
    // This ensures previouslyBooked providers are visible in the first page.
    if (hasCustomerID) {
      ordered.sort((a, b) => {
        const ap = a.previouslyBooked ? 1 : 0;
        const bp = b.previouslyBooked ? 1 : 0;
        if (bp !== ap) return bp - ap;

        const af = a.monthlyAvailability.fullyAvailable ? 1 : 0;
        const bf = b.monthlyAvailability.fullyAvailable ? 1 : 0;
        if (bf !== af) return bf - af;

        return a.distance_km - b.distance_km;
      });
    }

    const bestMatchCandidate = ordered.find(
      (p) =>
        p.monthlyAvailability.fullyAvailable &&
        !p.hasCustomerOverlap
    );
    if (bestMatchCandidate) {
      bestMatchCandidate.bestMatch = true;
    }

    /* ---------- STEP 6: Pagination ---------- */
    const startIndex = (page - 1) * limit;
    const paginated = ordered.slice(startIndex, startIndex + limit);

    res.json({
      count: ordered.length,
      page,
      limit,
      providers: paginated
    });

  } catch (err) {
    console.error("❌ nearby-monthly error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
