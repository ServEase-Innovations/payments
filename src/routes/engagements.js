// routes/engagements.js  (Version A — Epoch Only, combined: PUT, vacation, cancellation, payouts)
import express from "express";
import pool from "../config/db.js";
import { PG_IST_TODAY_DATE } from "../config/istDateSql.js";
import Razorpay from "razorpay";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import geolib from "geolib";
import {
  createServiceDays,
  repairTodayServiceDays,
} from "../routes/serviceDays.service.js";
import { calendarYmd } from "../services/providerAvailabilityOverlap.js";
import {
  createInAppNotification,
  InAppTypes,
  dismissNewBookingInAppByEngagementId,
} from "../services/inAppNotification.service.js";
import { deriveTaskStatusForCustomer } from "../utils/engagementTaskStatus.js";
import { resolvePricingForEngagement } from "../services/pricing/engagementPricing.js";
import { findProviderBookedConflict } from "../services/providerAvailabilityOverlap.js";


dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_lTdgjtSRlEwreA",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "g15WB8CEwaYBQ5FqpIKKMdNS",
});

// ----------------- Helpers -----------------

function toEpochSeconds(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dt = dayjs.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
  if (!dt.isValid()) return null;
  return dt.unix();
}

function toFiniteEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function dateYmdFromEpoch(epochSeconds) {
  const epoch = toFiniteEpoch(epochSeconds);
  if (epoch == null) return null;
  return dayjs.unix(epoch).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

function normalizeYmdInput(dateLike) {
  if (!dateLike) return null;
  if (typeof dateLike === "string") {
    const trimmed = dateLike.trim();
    const strict = dayjs.tz(trimmed.slice(0, 10), "YYYY-MM-DD", "Asia/Kolkata");
    if (strict.isValid()) return strict.format("YYYY-MM-DD");
    const parsed = dayjs.tz(trimmed, "Asia/Kolkata");
    if (parsed.isValid()) return parsed.format("YYYY-MM-DD");
    return null;
  }
  const parsed = dayjs(dateLike).tz("Asia/Kolkata");
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
}

function epochToTimeHM(epochSeconds) {
  if (!epochSeconds) return null;
  return dayjs.unix(Number(epochSeconds)).tz("Asia/Kolkata").format("HH:mm");
}

function normalizeDateToIST(dateValue) {
  if (!dateValue) return null;
  const d = new Date(dateValue);
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

function enumerateDates(start, end) {
  const res = [];
  const cur = new Date(start);
  while (cur <= end) {
    res.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return res;
}

async function getCustomerWalletId(client, customerId) {
  const walletRes = await client.query(`SELECT wallet_id FROM customer_wallets WHERE customerid=$1`, [customerId]);
  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(`INSERT INTO customer_wallets (customerid, balance) VALUES ($1,0) RETURNING wallet_id`, [customerId]);
    return insertRes.rows[0].wallet_id;
  }
  return walletRes.rows[0].wallet_id;
}

async function ensureProviderWallet(client, providerId) {
  if (!providerId) return null;
  const walletRes = await client.query(`SELECT * FROM provider_wallets WHERE serviceproviderid=$1`, [providerId]);
  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(`INSERT INTO provider_wallets (serviceproviderid, balance, security_deposit_collected) VALUES ($1,0,0) RETURNING *`, [providerId]);
    return insertRes.rows[0];
  }
  return walletRes.rows[0];
}

// small util: compute daily rate
function computeDailyRate(baseAmount, startDate, endDate) {
  const totalDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) + 1;
  return Number(baseAmount) / totalDays;
}





// ----------------- CREATE Engagement -----------------

router.post("/", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customerid,
      serviceproviderid, // optional (MONTHLY), always null for ON_DEMAND
      start_date,
      end_date,
      start_time,
      start_epoch,
      end_epoch,
      start_date_epoch,
      end_date_epoch,
      responsibilities,
      booking_type, // ON_DEMAND | MONTHLY
      service_type,
      base_amount,
      address,
      latitude,
      longitude,
      payment_mode = "razorpay",
    } = req.body;

    const isOnDemand = booking_type === "ON_DEMAND";
    const resolvedStartEpoch =
      toFiniteEpoch(start_epoch) ??
      toEpochSeconds(
        normalizeYmdInput(start_date) ?? dateYmdFromEpoch(start_date_epoch),
        start_time
      );
    const resolvedStartDate =
      normalizeYmdInput(start_date) ??
      dateYmdFromEpoch(resolvedStartEpoch) ??
      dateYmdFromEpoch(start_date_epoch);
    const resolvedStartTime = start_time || epochToTimeHM(resolvedStartEpoch);
    const resolvedEndEpoch =
      toFiniteEpoch(end_epoch) ??
      (resolvedStartEpoch != null
        ? resolvedStartEpoch + (isOnDemand ? 2 : 1) * 3600
        : null);
    const resolvedEndDate =
      normalizeYmdInput(end_date) ??
      dateYmdFromEpoch(resolvedEndEpoch) ??
      dateYmdFromEpoch(end_date_epoch) ??
      resolvedStartDate;

    // 1️⃣ Validation
    if (
      !customerid ||
      !resolvedStartDate ||
      !resolvedStartTime ||
      !resolvedEndDate ||
      !base_amount ||
      !booking_type ||
      !service_type
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const providerId = isOnDemand ? null : serviceproviderid;
    const assignment_status = isOnDemand ? "UNASSIGNED" : "ASSIGNED";

    // 2️⃣ Epochs
    const startEpoch = resolvedStartEpoch;
    if (!startEpoch) throw new Error("Invalid date/time");

    const hoursToAdd = isOnDemand ? 2 : 1;
    const endEpoch = resolvedEndEpoch ?? startEpoch + hoursToAdd * 3600;
    const effectiveEndDate = isOnDemand ? resolvedStartDate : resolvedEndDate;


    await client.query("BEGIN");

    let responsibilitiesPayload = responsibilities;
    try {
      const priced = await resolvePricingForEngagement(req.body, client);
      if (priced) responsibilitiesPayload = priced.responsibilities;
    } catch (pricingErr) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: pricingErr.message });
    }

    // 3️⃣ FK validation
    const cust = await client.query(
      `SELECT customerid, firstname, lastname FROM customer WHERE customerid=$1`,
      [customerid]
    );
    if (cust.rows.length === 0) throw new Error("Customer not found");

    if (providerId) {
      const prov = await client.query(
        `SELECT serviceproviderid FROM serviceprovider WHERE serviceproviderid=$1`,
        [providerId]
      );
      if (prov.rows.length === 0) throw new Error("Provider not found");
    }

    // 4️⃣ Overlap check (ONLY for non-ON_DEMAND) — clip DB slots to start_date’s IST calendar day
    if (providerId && !isOnDemand) {
      const day = resolvedStartDate;
      const dayWindowStart = toEpochSeconds(day, "00:00");
      const dayWindowEnd = dayWindowStart != null ? dayWindowStart + 86400 : null;
      if (dayWindowStart != null && dayWindowEnd != null) {
        const overlap = await client.query(
          `SELECT 1 FROM provider_availability
           WHERE serviceproviderid=$1
             AND status = 'BOOKED'
             AND date = $4::date
             AND slot_start_epoch IS NOT NULL
             AND slot_end_epoch IS NOT NULL
             AND GREATEST(slot_start_epoch, $5::bigint) < LEAST(slot_end_epoch, $6::bigint)
             AND $2::bigint < LEAST(slot_end_epoch, $6::bigint)
             AND $3::bigint > GREATEST(slot_start_epoch, $5::bigint)
           LIMIT 1`,
          [providerId, startEpoch, endEpoch, day, dayWindowStart, dayWindowEnd]
        );
        if (overlap.rows.length) {
          throw new Error("Provider already has a booking at this time");
        }
      }
    }

    // 5️⃣ Create engagement
    const engRes = await client.query(
  `
  INSERT INTO engagements (
    customerid,
    serviceproviderid,
    start_date,
    end_date,
    responsibilities,
    booking_type,
    service_type,
    task_status,
    active,
    base_amount,
    assignment_status,
    start_epoch,
    end_epoch,
    address,
    latitude,
    longitude,
    created_at
  )
  VALUES (
    $1,$2,$3::date,$4::date,$5,$6,$7,
    'NOT_STARTED',true,$8,$9,$10,$11,$12,$13,$14,NOW()
  )
  RETURNING *
  `,
  [
    customerid,
    providerId,
    resolvedStartDate,
    effectiveEndDate,   // ✅ IMPORTANT
    responsibilitiesPayload,
    booking_type,
    service_type,
    base_amount,
    assignment_status,
    startEpoch,
    endEpoch,
    address || null,
    latitude,
    longitude,
  ]
);


    const engagement = engRes.rows[0];

    // 6️⃣ Create service_days ONLY for non-ON_DEMAND
    if (!isOnDemand) {
      await createServiceDays(client, engagement.engagement_id, resolvedStartDate, effectiveEndDate);
    }

    // 7️⃣ Provider availability ONLY for non-ON_DEMAND
    if (providerId && !isOnDemand) {
      const startD = new Date(resolvedStartDate);
      const endD = new Date(effectiveEndDate);
      const dailyStartTime = epochToTimeHM(startEpoch);
      if (!dailyStartTime) throw new Error("Unable to derive slot start time");


      for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
        const day = d.toISOString().slice(0, 10);
        const dayStartEpoch = toEpochSeconds(day, dailyStartTime);
        const dayEndEpoch = dayStartEpoch + hoursToAdd * 3600;

        await client.query(
          `
          INSERT INTO provider_availability
          (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
          VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())
          `,
          [providerId, engagement.engagement_id, day, dayStartEpoch, dayEndEpoch]
        );
      }
    }

    // 8️⃣ Payment (PENDING)
    const platform_fee = Math.round(Number(base_amount) * 0.06 * 100) / 100;
    const gst = Math.round(platform_fee * 0.18 * 100) / 100;
    const total_amount = Math.round((Number(base_amount) + platform_fee + gst) * 100) / 100;

    let razorpay_order_id = null;
    if (payment_mode === "razorpay") {
      const order = await razorpay.orders.create({
        amount: Math.round(total_amount * 100),
        currency: "INR",
        receipt: `eng_${engagement.engagement_id}`,
      });
      razorpay_order_id = order.id;
    }

    const paymentRes = await client.query(
      `
      INSERT INTO payments
      (engagement_id, base_amount, platform_fee, gst, total_amount, payment_mode, status, razorpay_order_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,NOW())
      RETURNING *
      `,
      [
        engagement.engagement_id,
        base_amount,
        platform_fee,
        gst,
        total_amount,
        payment_mode,
        razorpay_order_id,
      ]
    );

    await client.query("COMMIT");

    

   if (!providerId && latitude && longitude) {
  const providerRes = await pool.query(`
    SELECT serviceproviderid, latitude, longitude
    FROM serviceprovider
    WHERE isactive = true
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
  `);

  const nearbyProviders = providerRes.rows.filter((p) => {
    const distance = geolib.getDistance(
      { latitude, longitude },
      { latitude: p.latitude, longitude: p.longitude }
    );
    return distance <= 5000;
  });

  console.log("Nearby providers found:", nearbyProviders.length);

  // for (const p of nearbyProviders) {
  //   const room = `provider_${p.serviceproviderid}`;

  //   const sockets = await req.io.in(room).fetchSockets();

  //   console.log(`📡 ${room} sockets:`, sockets.length);

  //   if (sockets.length > 0) {
  //     req.io.to(room).emit("new-engagement", {
  //       engagement: {
  //         engagement_id: engagement.engagement_id,
  //         service_type,
  //         booking_type,
  //         start_date,
  //         end_date,
  //         start_time,
  //         base_amount,
  //       },
  //     });

  //     console.log(`🚀 Notification sent to ${room}`);
  //   }
  // }
}


    // 🔟 Response
    return res.status(201).json({
      message: "Engagement created successfully",
      engagement,
      payment: paymentRes.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create engagement error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET modification history for one engagement (audit: who changed what, when)
router.get("/:id/modifications", async (req, res) => {
  try {
    const { id } = req.params;
    if (id == null || String(id).trim() === "" || !/^\d+$/.test(String(id).trim())) {
      return res.status(400).json({ error: "Invalid engagement id" });
    }
    const r = await pool.query(
      `SELECT
        modification_id,
        engagement_id,
        modified_at,
        created_at,
        modified_fields,
        modified_by_id,
        modified_by_role,
        modification_type,
        modified_type,
        old_start_date,
        new_start_date
       FROM engagement_modifications
       WHERE engagement_id = $1
       ORDER BY modified_at DESC
       LIMIT 200`,
      [id]
    );
    const rows = r.rows.map((row) => ({
      ...row,
      modified_fields:
        row.modified_fields == null
          ? null
          : typeof row.modified_fields === "string"
            ? JSON.parse(row.modified_fields)
            : row.modified_fields,
    }));
    return res.json({ success: true, engagement_id: id, modifications: rows });
  } catch (err) {
    console.error("engagement modifications list error:", err);
    return res.status(500).json({ error: "Failed to list modifications" });
  }
});

// GET today's booked visits for a customer (IST calendar day, by start time)
router.get("/:customerId/today-bookings", async (req, res) => {
  const cid = Number(req.params.customerId);
  if (!Number.isFinite(cid) || cid < 1) {
    return res.status(400).json({ success: false, error: "Invalid customer id" });
  }

  try {
    const cust = await pool.query(
      `SELECT 1 FROM customer WHERE customerid = $1`,
      [cid]
    );
    if (cust.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Customer not found" });
    }

    const paToday = await pool.query(
      `
      SELECT DISTINCT pa.engagement_id
      FROM provider_availability pa
      JOIN engagements e ON e.engagement_id = pa.engagement_id
      WHERE e.customerid = $1
        AND pa.date = ${PG_IST_TODAY_DATE}
        AND pa.status = 'BOOKED'
        AND pa.engagement_id IS NOT NULL
      `,
      [cid]
    );
    const todayEngIds = paToday.rows.map((r) => r.engagement_id);
    if (todayEngIds.length > 0) {
      await repairTodayServiceDays(pool, todayEngIds);
    }

    const result = await pool.query(
      `
      WITH today_ist AS (
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS d
      ),
      booked_visits AS (
        SELECT
          pa.id AS availability_id,
          pa.engagement_id,
          pa.date::text AS visit_date,
          pa.slot_start_epoch,
          pa.slot_end_epoch,
          e.start_epoch,
          e.end_epoch,
          pa.status AS availability_status,
          e.booking_type,
          e.service_type,
          e.task_status,
          e.engagement_status,
          e.assignment_status,
          e.address,
          e.base_amount,
          e.duration_minutes,
          sp.serviceproviderid,
          sp.firstname AS provider_firstname,
          sp.lastname AS provider_lastname,
          sp.mobileno AS provider_mobileno,
          sp.rating AS provider_rating,
          sd.service_day_id,
          sd.status AS service_day_status
        FROM provider_availability pa
        CROSS JOIN today_ist t
        JOIN engagements e ON e.engagement_id = pa.engagement_id
        LEFT JOIN serviceprovider sp ON sp.serviceproviderid = e.serviceproviderid
        LEFT JOIN LATERAL (
          SELECT s.service_day_id, s.status
          FROM service_days s
          WHERE s.engagement_id = e.engagement_id
            AND s.service_date = pa.date
          ORDER BY s.service_day_id
          LIMIT 1
        ) sd ON true
        WHERE e.customerid = $1
          AND pa.date = t.d
          AND pa.status = 'BOOKED'
          AND pa.engagement_id IS NOT NULL
      ),
      pending_on_demand AS (
        SELECT
          (-e.engagement_id)::bigint AS availability_id,
          e.engagement_id,
          t.d::text AS visit_date,
          e.start_epoch AS slot_start_epoch,
          e.end_epoch AS slot_end_epoch,
          e.start_epoch,
          e.end_epoch,
          'UNASSIGNED' AS availability_status,
          e.booking_type,
          e.service_type,
          e.task_status,
          e.engagement_status,
          e.assignment_status,
          e.address,
          e.base_amount,
          e.duration_minutes,
          NULL::bigint AS serviceproviderid,
          NULL::text AS provider_firstname,
          NULL::text AS provider_lastname,
          NULL::bigint AS provider_mobileno,
          NULL::numeric AS provider_rating,
          NULL::bigint AS service_day_id,
          NULL::text AS service_day_status
        FROM engagements e
        CROSS JOIN today_ist t
        WHERE e.customerid = $1
          AND e.start_date <= t.d
          AND e.end_date >= t.d
          AND UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
          AND UPPER(COALESCE(e.assignment_status, '')) = 'UNASSIGNED'
          AND UPPER(COALESCE(e.engagement_status, '')) NOT IN ('CANCELLED')
          AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED')
          AND NOT EXISTS (
            SELECT 1
            FROM provider_availability pa2
            WHERE pa2.engagement_id = e.engagement_id
              AND pa2.date = t.d
              AND pa2.status = 'BOOKED'
          )
      )
      SELECT * FROM booked_visits
      UNION ALL
      SELECT * FROM pending_on_demand
      ORDER BY slot_start_epoch ASC NULLS LAST, availability_id ASC
      `,
      [cid]
    );

    const serviceDayIds = result.rows
      .map((r) => r.service_day_id)
      .filter((id) => id != null);
    const otpByServiceDay = {};
    if (serviceDayIds.length > 0) {
      const otpRes = await pool.query(
        `
        SELECT service_day_id
        FROM service_day_otps
        WHERE service_day_id = ANY($1)
          AND verified_at IS NULL
          AND expires_at > NOW()
        `,
        [serviceDayIds]
      );
      otpRes.rows.forEach((o) => {
        otpByServiceDay[o.service_day_id] = true;
      });
    }

    const rows = result.rows.map((row) => {
      const startEp = row.slot_start_epoch != null ? Number(row.slot_start_epoch) : null;
      const endEp = row.slot_end_epoch != null ? Number(row.slot_end_epoch) : null;
      const sdStatus = row.service_day_status || null;
      const sdUpper = sdStatus ? String(sdStatus).toUpperCase() : "";
      const otpActive = row.service_day_id
        ? !!otpByServiceDay[row.service_day_id]
        : false;
      return {
        availability_id: Number(row.availability_id),
        engagement_id: Number(row.engagement_id),
        visit_date: row.visit_date,
        slot_start_epoch: startEp,
        slot_end_epoch: endEp,
        engagement_start_epoch:
          row.start_epoch != null ? Number(row.start_epoch) : null,
        engagement_end_epoch:
          row.end_epoch != null ? Number(row.end_epoch) : null,
        start_time_ist: startEp != null ? epochToTimeHM(startEp) : null,
        end_time_ist: endEp != null ? epochToTimeHM(endEp) : null,
        availability_status: row.availability_status,
        booking_type: row.booking_type,
        service_type: row.service_type,
        task_status: row.task_status,
        engagement_status: row.engagement_status,
        assignment_status: row.assignment_status,
        address: row.address || null,
        base_amount:
          row.base_amount != null ? Number(Number(row.base_amount).toFixed(2)) : null,
        duration_minutes:
          row.duration_minutes != null ? Number(row.duration_minutes) : null,
        serviceproviderid:
          row.serviceproviderid != null ? Number(row.serviceproviderid) : null,
        provider_firstname: row.provider_firstname || null,
        provider_lastname: row.provider_lastname || null,
        provider_mobileno: row.provider_mobileno || null,
        provider_rating:
          row.provider_rating != null ? Number(row.provider_rating) : null,
        service_day_id:
          row.service_day_id != null ? Number(row.service_day_id) : null,
        service_day_status: sdStatus,
        today_service: row.service_day_id
          ? {
              service_day_id: Number(row.service_day_id),
              status: sdStatus,
              can_generate_otp: sdUpper === "IN_PROGRESS" && !otpActive,
              otp_active: otpActive,
            }
          : null,
      };
    });

    const istDay = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");

    return res.json({
      success: true,
      customerid: String(cid),
      date: istDay,
      timezone: "Asia/Kolkata",
      count: rows.length,
      bookings: rows,
    });
  } catch (err) {
    console.error("Error fetching customer today-bookings:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// GET all engagements for a customer (FULL VERSION)
// Includes: provider details, payments, modifications, vacations, epoch times

router.get("/:customerId/engagements", async (req, res) => {
  try {
    const { customerId } = req.params;

    // ---- Fetch all engagements ----
    const engagementsRes = await pool.query(
      `SELECT * FROM engagements WHERE customerid=$1 ORDER BY start_date ASC`,
      [customerId]
    );

    if (engagementsRes.rows.length === 0) {
      return res.json({ upcoming: [], ongoing: [], past: [], cancelled: [] });
    }

    const engagements = engagementsRes.rows;
    const engagementIds = engagements.map(e => e.engagement_id);

    await repairTodayServiceDays(pool, engagementIds);

    // ---- Fetch today's service days ----
    const todayServiceRes = await pool.query(
      `
      SELECT
        service_day_id,
        engagement_id,
        status,
        started_at,
        completed_at
      FROM service_days
      WHERE engagement_id = ANY($1)
        AND service_date = ${PG_IST_TODAY_DATE}
      `,
      [engagementIds]
    );

    const todayServiceByEng = {};
    todayServiceRes.rows.forEach(sd => {
      todayServiceByEng[sd.engagement_id] = sd;
    });

    // ---- Fetch active OTPs ----
    const serviceDayIds = todayServiceRes.rows.map(s => s.service_day_id);
    const otpByServiceDay = {};

    if (serviceDayIds.length > 0) {
      const otpRes = await pool.query(
        `
        SELECT service_day_id
        FROM service_day_otps
        WHERE service_day_id = ANY($1)
          AND verified_at IS NULL
          AND expires_at > NOW()
        `,
        [serviceDayIds]
      );

      otpRes.rows.forEach(o => {
        otpByServiceDay[o.service_day_id] = true;
      });
    }

    // ---- Fetch modifications ----
    const modRes = await pool.query(
      `SELECT engagement_id, modified_at, modified_fields
       FROM engagement_modifications
       WHERE engagement_id = ANY($1)
       ORDER BY modified_at DESC`,
      [engagementIds]
    );

    // ---- Fetch payments ----
    const paymentsRes = await pool.query(
      `SELECT engagement_id, base_amount, platform_fee, gst, total_amount,
              payment_mode, status, created_at
       FROM payments
       WHERE engagement_id = ANY($1)`,
      [engagementIds]
    );

    // ---- Fetch provider details ----
    const providerIds = engagements.map(e => e.serviceproviderid).filter(Boolean);
    const providerRes = await pool.query(
      `SELECT
  sp.serviceproviderid,
  sp.firstname AS "firstName",
  sp.lastname AS "lastName",
  sp.rating
FROM serviceprovider sp
WHERE sp.serviceproviderid = ANY($1)`,
      [providerIds]
    );

    // ---- Maps ----
    const providerById = {};
    providerRes.rows.forEach(p => providerById[p.serviceproviderid] = p);

    const paymentByEng = {};
    paymentsRes.rows.forEach(p => paymentByEng[p.engagement_id] = p);

    const modsByEng = {};
    const vacationsByEng = {};

    modRes.rows.forEach(mod => {
      const parsed =
        typeof mod.modified_fields === "string"
          ? JSON.parse(mod.modified_fields)
          : mod.modified_fields;

      if (!modsByEng[mod.engagement_id]) modsByEng[mod.engagement_id] = [];
      if (!vacationsByEng[mod.engagement_id]) vacationsByEng[mod.engagement_id] = [];

      let action = "Modified";
      if (parsed?.modification_type === "VACATION_ADDED") action = "Vacation Applied";
      if (parsed?.modification_type === "VACATION_MODIFIED") action = "Vacation Updated";
      if (parsed?.modification_type === "VACATION_CANCELLED") action = "Vacation Cancelled";

      modsByEng[mod.engagement_id].push({
        date: mod.modified_at,
        action,
        refund: parsed?.updated?.refund ?? parsed?.wallet_effect?.customer_credit ?? null,
        penalty: parsed?.wallet_effect?.customer_debit ?? parsed?.updated?.penalty ?? null,
      });

      if (parsed?.modification_type?.startsWith("VACATION")) {
        vacationsByEng[mod.engagement_id].push({
          start_date: parsed?.updated?.vacation_start_date,
          end_date: parsed?.updated?.vacation_end_date,
          leave_days: parsed?.updated?.leave_days,
          refund: parsed?.updated?.refund,
          penalty: parsed?.updated?.penalty,
          action,
          applied_on: mod.modified_at,
        });
      }
    });

    // ---- Group engagements ----
    const upcoming = [];
    const ongoing = [];
    const past = [];
    const cancelled = [];

    const today = dayjs().tz("Asia/Kolkata").startOf("day");

    engagements.forEach((e) => {
      const life = (e.engagement_status && String(e.engagement_status).toUpperCase()) || "";
      const storedTask = (e.task_status && String(e.task_status).toUpperCase()) || "";
      const isCancelled = life === "CANCELLED" || storedTask === "CANCELLED";

      const engagementStart = dayjs(e.start_date).startOf("day");
      const engagementEnd = dayjs(e.end_date).endOf("day");

      const todayService = todayServiceByEng[e.engagement_id] || null;

      let today_service = null;
      if (todayService) {
        today_service = {
          service_day_id: todayService.service_day_id,
          status: todayService.status,
          can_start: todayService.status === "SCHEDULED",
          can_generate_otp: todayService.status === "IN_PROGRESS",
          can_complete: todayService.status === "IN_PROGRESS",
          otp_active: !!otpByServiceDay[todayService.service_day_id]
        };
      }

      let bucket = today.isBefore(engagementStart)
        ? "upcoming"
        : today.isAfter(engagementEnd)
          ? "past"
          : "ongoing";

      const bookingType = String(e.booking_type || "").toUpperCase();
      const dayStatusUpper = todayService
        ? String(todayService.status || "").toUpperCase()
        : "";
      if (bookingType === "ON_DEMAND") {
        const nowUnix = dayjs().tz("Asia/Kolkata").unix();
        const startEpRaw = Number(e.start_epoch);
        const endEpRaw = Number(e.end_epoch);
        const startEp = Number.isFinite(startEpRaw) && startEpRaw > 0 ? startEpRaw : null;
        const endEp = Number.isFinite(endEpRaw) && endEpRaw > 0 ? endEpRaw : null;
        if (
          dayStatusUpper === "IN_PROGRESS" ||
          dayStatusUpper === "STARTED"
        ) {
          bucket = "ongoing";
        } else if (dayStatusUpper === "COMPLETED") {
          bucket = "past";
        } else if (endEp != null && nowUnix >= endEp) {
          bucket = "past";
        } else if (startEp != null && nowUnix < startEp) {
          bucket = "upcoming";
        } else {
          bucket = "ongoing";
        }
      }

      const { task_status, work_summary } = deriveTaskStatusForCustomer(e, bucket, todayService);
      const { task_status: taskStatusStored, ...engCore } = e;

      const startEpoch = Number(e.start_epoch);
      const endEpoch = Number(e.end_epoch);
      const safeStartTime =
        Number.isFinite(startEpoch) && startEpoch > 0
          ? dayjs.unix(startEpoch).tz("Asia/Kolkata").format("HH:mm")
          : null;
      const safeEndTime =
        Number.isFinite(endEpoch) && endEpoch > 0
          ? dayjs.unix(endEpoch).tz("Asia/Kolkata").format("HH:mm")
          : null;

      const enriched = {
        ...engCore,
        task_status,
        task_status_stored: taskStatusStored,
        work_summary,
        start_time: safeStartTime,
        end_time: safeEndTime,
        provider: providerById[e.serviceproviderid] || null,
        payment: paymentByEng[e.engagement_id] || null,
        modifications: modsByEng[e.engagement_id] || [],
        vacations: vacationsByEng[e.engagement_id] || [],
        today_service
      };

      if (isCancelled) {
        cancelled.push(enriched);
      } else if (bucket === "upcoming") {
        upcoming.push(enriched);
      } else if (bucket === "past") {
        past.push(enriched);
      } else {
        ongoing.push(enriched);
      }
    });

    return res.json({ upcoming, ongoing, past, cancelled });

  } catch (err) {
    console.error("GET engagements error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});




// ----------------- PUT /:id — update engagement (supports time/provider/date changes & vacation) -----------------
//
// Supports:
// - updating start_date, end_date, start_time (recomputes epochs & availability)
// - changing serviceproviderid (reassign provider) — will check availability/conflicts
// - applying/modifying/cancelling vacation (see fields below)
// - updating other fields: responsibilities, booking_type, service_type, base_amount, task_status, active
//
// Vacation-specific fields (in body):
//  - vacation_start_date (YYYY-MM-DD)
//  - vacation_end_date   (YYYY-MM-DD)
//  - cancel_vacation (boolean)
//  - modified_by_id, modified_by_role
//
// Note: business rules you confirmed:
//  - refund = dailyRate * leaveDays
//  - penalty = 400 when modifying existing vacation
//
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;
  try {
    await client.query("BEGIN");

    // Lock engagement row
    const engRow = await client.query(`SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`, [id]);
    if (engRow.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Engagement not found" }); }
    const oldEng = engRow.rows[0];

    const providerBefore = oldEng.serviceproviderid;
    const customerId = oldEng.customerid;

    // ensure wallets exist
    const customerWalletId = await getCustomerWalletId(client, customerId);
    await ensureProviderWallet(client, providerBefore);

    // Extract body
    const body = req.body || {};
    const {
      start_date,
      end_date,
      start_time,
      start_epoch,
      end_epoch,
      start_date_epoch,
      end_date_epoch,
      serviceproviderid,
      responsibilities,
      booking_type,
      service_type,
      base_amount,
      task_status,
      active,
      vacation_start_date,
      vacation_end_date,
      vacation_start_epoch,
      vacation_end_epoch,
      cancel_vacation,
      modified_by_id,
      modified_by_role
    } = body;

    const vacationStartDateResolved =
      normalizeYmdInput(vacation_start_date) ?? dateYmdFromEpoch(vacation_start_epoch);
    const vacationEndDateResolved =
      normalizeYmdInput(vacation_end_date) ?? dateYmdFromEpoch(vacation_end_epoch);

    const isVacationOperation = (vacationStartDateResolved !== undefined && vacationStartDateResolved !== null) || (vacationEndDateResolved !== undefined && vacationEndDateResolved !== null) || (cancel_vacation);

    // If it's a non-vacation update that can include changing time/provider/dates -> handle separately
    if (!isVacationOperation) {
      // Build update set
      const setClauses = [];
      const values = [];
      let idx = 1;

      // fields allowed to update (including changing provider/time/date)
      const mapping = {
        start_date: { cast: '::date' },
        end_date: { cast: '::date' },
        responsibilities: { json: true },
        booking_type: {},
        service_type: {},
        task_status: {},
        active: {},
        base_amount: {},
        serviceproviderid: {},
      };

      for (const f of Object.keys(mapping)) {
        if (body[f] !== undefined) {
          if (f === 'responsibilities') {
            setClauses.push(`${f} = $${idx++}`);
            values.push(JSON.stringify(body[f]));
          } else {
            setClauses.push(`${f} = $${idx++}`);
            values.push(body[f]);
          }
        }
      }

      // handle time/date -> recompute epochs and update provider_availability accordingly
      let newStartEpoch = oldEng.start_epoch;
      let newEndEpoch = oldEng.end_epoch;
      let newStartDate = oldEng.start_date;
      let newEndDate = oldEng.end_date;
      let newProviderId = (body.serviceproviderid !== undefined) ? body.serviceproviderid : oldEng.serviceproviderid;

      const bodyStartEpoch = toFiniteEpoch(start_epoch);
      const bodyEndEpoch = toFiniteEpoch(end_epoch);
      const bodyStartDate = normalizeYmdInput(start_date) ?? dateYmdFromEpoch(start_date_epoch);
      const bodyEndDate = normalizeYmdInput(end_date) ?? dateYmdFromEpoch(end_date_epoch);

      if (bodyStartEpoch != null) {
        newStartEpoch = bodyStartEpoch;
        newStartDate = dateYmdFromEpoch(bodyStartEpoch) || newStartDate;
      }
      if (bodyEndEpoch != null) {
        newEndEpoch = bodyEndEpoch;
        newEndDate = dateYmdFromEpoch(bodyEndEpoch) || newEndDate;
      }
      if (bodyStartDate) {
        newStartDate = bodyStartDate;
        if (!bodyStartEpoch && (start_time || oldEng.start_epoch)) {
          const timeForStart = start_time || epochToTimeHM(oldEng.start_epoch);
          newStartEpoch = toEpochSeconds(bodyStartDate, timeForStart);
        }
      }
      if (bodyEndDate) {
        newEndDate = bodyEndDate;
      }

      if ((start_date && start_time) || (start_date && !start_time && oldEng.start_epoch)) {
        // we have a new start_date and possibly start_time -> compute newStartEpoch
        const timeForStart = start_time || epochToTimeHM(oldEng.start_epoch);
        newStartEpoch = toEpochSeconds(start_date, timeForStart);
        newStartDate = start_date;
      } else if (start_time && !start_date) {
        // change only time; date stays same
        const timeForStart = start_time;
        newStartEpoch = toEpochSeconds(oldEng.start_date.toISOString ? oldEng.start_date.toISOString().slice(0,10) : oldEng.start_date, timeForStart);
        newStartDate = normalizeDateToIST(oldEng.start_date);
      }

      if ((end_date && start_time) || (end_date && !start_time && oldEng.end_epoch)) {
        const timeForEnd = start_time || epochToTimeHM(oldEng.end_epoch);
        // endEpoch computed by adding duration (we preserve original duration)
        // original duration:
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        newEndEpoch = (newStartEpoch) ? newStartEpoch + origDur : oldEng.end_epoch;
        newEndDate = end_date;
      } else if (end_date && !start_time) {
        // date changed only: shift end accordingly preserving time
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        const startForNew = toEpochSeconds(end_date, epochToTimeHM(oldEng.start_epoch));
        newEndEpoch = startForNew + origDur;
        newEndDate = end_date;
      } else if (start_time && !end_date && !start_date) {
        // only time changed -> shift end as well preserving duration
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        const startForNew = toEpochSeconds(normalizeDateToIST(oldEng.start_date), start_time);
        newStartEpoch = startForNew;
        newEndEpoch = startForNew + origDur;
      }

      // If provider changed, validate new provider
      if (newProviderId && newProviderId !== providerBefore) {
        const provCheck = await client.query(`SELECT 1 FROM serviceprovider WHERE serviceproviderid=$1`, [newProviderId]);
        if (provCheck.rows.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "New provider not found" }); }
        await ensureProviderWallet(client, newProviderId);
      }

      // Overlap checks for new provider/time/dates: check each daily slot that would be created
      // Build list of dates for new availability
      const startDateOnly = newStartDate ? new Date(newStartDate) : new Date(oldEng.start_date);
      const endDateOnly = newEndDate ? new Date(newEndDate) : new Date(oldEng.end_date);
      const dateList = enumerateDates(startDateOnly, endDateOnly);

      // compute representative daily slot times (HH:mm) from newStartEpoch
      const dailyStartTime = epochToTimeHM(newStartEpoch);
      const dailyEndTime = epochToTimeHM(newEndEpoch);

      // check conflicts for each day if provider assigned
      if (newProviderId) {
        for (const day of dateList) {
          const dayStart = toEpochSeconds(day, dailyStartTime);
          const dayEnd = dayStart + (Number(newEndEpoch) - Number(newStartEpoch));
          const conflict = await client.query(
            `SELECT engagement_id FROM provider_availability
             WHERE serviceproviderid=$1
               AND $2 < slot_end_epoch
               AND $3 > slot_start_epoch
               AND engagement_id != $4
             LIMIT 1`,
            [newProviderId, dayStart, dayEnd, id]
          );
          if (conflict.rows.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "Time overlap with another engagement for the provider", conflict: conflict.rows[0] });
          }
        }
      }

      // --- Proceed update: update provider_availability (free old provider slots, insert or update new provider slots)
      // Free old provider availability rows (for the engagement)
      if (providerBefore) {
        await client.query(`UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1`, [id]);
      }

      // Insert/Update availability for new provider (daily)
      if (newProviderId) {
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        // clear any existing rows for engagement for new provider's dates (defensive)
        for (const day of dateList) {
          const ds = toEpochSeconds(day, dailyStartTime);
          const de = ds + origDur;
          // if a row exists for this engagement & day -> update, else insert
          const exists = await client.query(
            `SELECT 1 FROM provider_availability WHERE engagement_id=$1 AND date=$2::date LIMIT 1`,
            [id, day]
          );
          if (exists.rows.length > 0) {
            await client.query(
              `UPDATE provider_availability
               SET serviceproviderid=$1, slot_start_epoch=$2, slot_end_epoch=$3, status='BOOKED', updated_at=NOW()
               WHERE engagement_id=$4 AND date=$5::date`,
              [newProviderId, ds, de, id, day]
            );
          } else {
            await client.query(
              `INSERT INTO provider_availability
                (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
               VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())`,
              [newProviderId, id, day, ds, de]
            );
          }
        }
      }

      // Now update engagements table with new computed epoch and provider if provided
      if (setClauses.length > 0) {
        values.push(id);
        await client.query(`UPDATE engagements SET ${setClauses.join(", ")} WHERE engagement_id=$${values.length}`, values);
      }

      // update epoch/date/provider fields explicitly if they changed
      const updateFields = [];
      const updateVals = [];
      let uIdx = 1;
      if (newStartEpoch !== oldEng.start_epoch) {
        updateFields.push(`start_epoch = $${uIdx++}`); updateVals.push(newStartEpoch);
      }
      if (newEndEpoch !== oldEng.end_epoch) {
        updateFields.push(`end_epoch = $${uIdx++}`); updateVals.push(newEndEpoch);
      }
      if (newStartDate && newStartDate !== oldEng.start_date) {
        updateFields.push(`start_date = $${uIdx++}::date`); updateVals.push(newStartDate);
      }
      if (newEndDate && newEndDate !== oldEng.end_date) {
        updateFields.push(`end_date = $${uIdx++}::date`); updateVals.push(newEndDate);
      }
      if (newProviderId !== providerBefore) {
        updateFields.push(`serviceproviderid = $${uIdx++}`); updateVals.push(newProviderId);
      }

      if (updateFields.length > 0) {
        updateVals.push(id);
        await client.query(`UPDATE engagements SET ${updateFields.join(", ")} WHERE engagement_id=$${updateVals.length}`, updateVals);
      }

      // Log modification
      await client.query(
        `INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
         VALUES ($1,$2::jsonb,$3,$4,NOW())`,
        [id, JSON.stringify({ updated_fields: body }), modified_by_id || null, modified_by_role || null]
      );

      await client.query("COMMIT");

      // return updated row
      const updated = (await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])).rows[0];
      updated.start_date = normalizeDateToIST(updated.start_date);
      updated.end_date = normalizeDateToIST(updated.end_date);
      updated.start_time = epochToTimeHM(updated.start_epoch);
      updated.end_time = epochToTimeHM(updated.end_epoch);
      return res.json({ message: "Engagement updated", engagement: updated });
    }

    // ---------- Vacation specific flows ----------
    // lock provider_availability rows for this engagement (we will update them)
    await ensureProviderWallet(client, providerBefore);

    // fetch previous vacation info
    const prevVacStart = oldEng.vacation_start_date ? new Date(oldEng.vacation_start_date) : null;
    const prevVacEnd = oldEng.vacation_end_date ? new Date(oldEng.vacation_end_date) : null;
    const prevDates = (prevVacStart && prevVacEnd) ? enumerateDates(prevVacStart, prevVacEnd) : [];

    // CANCEL vacation
    if (cancel_vacation) {
      if (prevDates.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "No existing vacation to cancel" }); }

      // compute refund revert (customer to be debited, provider credited)
      const dailyRate = computeDailyRate(oldEng.base_amount, oldEng.start_date, oldEng.end_date);
      const refundToRevert = (oldEng.leave_days || prevDates.length) * dailyRate;

      // ensure provider has availability free on those dates (no other engagements)
      await client.query(`SELECT 1 FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) FOR UPDATE`, [providerBefore, prevDates]);
      const conflicts = await client.query(
        `SELECT engagement_id, date FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) AND engagement_id != $3 AND status='BOOKED'`,
        [providerBefore, prevDates, id]
      );
      if (conflicts.rows.length > 0) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Cannot cancel vacation; provider is booked on some previously-vacation dates", conflicts: conflicts.rows }); }

      // wallet ops: debit customer, credit provider
      await client.query(`UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`, [refundToRevert, customerWalletId]);
      await client.query(`INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type) VALUES ($1,$2,$3,'DEBIT')`, [customerWalletId, id, refundToRevert]);

      await client.query(`UPDATE provider_wallets SET balance = balance + $1 WHERE serviceproviderid=$2`, [refundToRevert, providerBefore]);
      await client.query(`UPDATE payouts SET net_amount = net_amount + $1 WHERE engagement_id=$2`, [refundToRevert, id]);

      // restore provider availability rows (set to BOOKED)
      await client.query(`UPDATE provider_availability SET status='BOOKED' WHERE engagement_id=$1 AND date = ANY($2)`, [id, prevDates]);

      // update engagement
      await client.query(`UPDATE engagements SET vacation_start_date=NULL, vacation_end_date=NULL, leave_days=0 WHERE engagement_id=$1`, [id]);

      // audit
      const audit = {
        modification_type: "VACATION_CANCELLED",
        previous: { vacation_start_date: prevVacStart ? prevVacStart.toISOString().slice(0,10) : null, vacation_end_date: prevVacEnd ? prevVacEnd.toISOString().slice(0,10) : null, leave_days: prevDates.length },
        updated: null,
        wallet_effect: { customer_debit: refundToRevert, provider_credit: refundToRevert }
      };
      await client.query(`INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at) VALUES ($1,$2::jsonb,$3,$4,NOW())`, [id, JSON.stringify(audit), modified_by_id || null, modified_by_role || null]);

      await client.query("COMMIT");
      const updated = (await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])).rows[0];
      updated.start_date = normalizeDateToIST(updated.start_date);
      updated.end_date = normalizeDateToIST(updated.end_date);
      updated.start_time = epochToTimeHM(updated.start_epoch);
      updated.end_time = epochToTimeHM(updated.end_epoch);
      return res.json({ message: "Vacation cancelled", engagement: updated });
    }

    // APPLY or MODIFY vacation
      if (!vacationStartDateResolved || !vacationEndDateResolved) {
      await client.query("ROLLBACK"); return res.status(400).json({ error: "Both vacation_start_date and vacation_end_date are required" });
    }

    const vacStart = new Date(vacationStartDateResolved);
    const vacEnd = new Date(vacationEndDateResolved);
    if (vacStart > vacEnd) { await client.query("ROLLBACK"); return res.status(400).json({ error: "vacation_start_date must be <= vacation_end_date" }); }

    // ensure vacation within engagement bounds
    const engStart = new Date(oldEng.start_date);
    const engEnd = new Date(oldEng.end_date);
    if (vacStart < engStart || vacEnd > engEnd) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Vacation dates must fall within engagement start/end dates" }); }

    const newDates = enumerateDates(vacStart, vacEnd);
    const restoredDates = prevDates.filter(d => !newDates.includes(d)); // dates being restored (previously vacation, now active)
    const freedDates = newDates.filter(d => !prevDates.includes(d)); // dates that become vacation (become free)

    // If restoredDates exist -> check provider availability conflicts & time overlaps
    if (restoredDates.length > 0) {
      // compute daily start time (HH:mm) from engagement epochs
      const checkStartTime = epochToTimeHM(oldEng.start_epoch);
      const checkEndTime = epochToTimeHM(oldEng.end_epoch);
      if (!checkStartTime || !checkEndTime) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Missing start/end time for overlap checks" }); }

      // lock candidate rows
      await client.query(`SELECT 1 FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) FOR UPDATE`, [providerBefore, restoredDates]);

      // check for booked conflicts
      const availConflicts = await client.query(
        `SELECT date, engagement_id FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) AND engagement_id != $3 AND status='BOOKED'`,
        [providerBefore, restoredDates, id]
      );
      if (availConflicts.rows.length > 0) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Provider is already booked on some restored dates", conflicts: availConflicts.rows }); }

      // time overlap check using epoch math per day
      for (const day of restoredDates) {
        const dayStartEpoch = toEpochSeconds(day, checkStartTime);
        const dayEndEpoch = toEpochSeconds(day, checkEndTime);
        if (!dayStartEpoch || !dayEndEpoch || dayStartEpoch >= dayEndEpoch) { await client.query("ROLLBACK"); return res.status(400).json({ error: `Invalid computed time range for date ${day}` }); }

        const timeConflict = await client.query(
          `SELECT engagement_id, date FROM provider_availability WHERE serviceproviderid=$1 AND date=$2::date AND engagement_id != $3 AND $4 < slot_end_epoch AND $5 > slot_start_epoch LIMIT 1`,
          [providerBefore, day, id, dayStartEpoch, dayEndEpoch]
        );
        if (timeConflict.rows.length > 0) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Time overlap with other engagements on restored dates", conflict: timeConflict.rows[0] }); }
      }
    }

    // compute refund and penalty
    const dailyRate = computeDailyRate(oldEng.base_amount, oldEng.start_date, oldEng.end_date);
    const prevLeaveDays = oldEng.leave_days || prevDates.length || 0;
    const newLeaveDays = newDates.length;
    const refundAmount = newLeaveDays * dailyRate;
    let penalty = 0;
    if (prevLeaveDays > 0) penalty = 400; // business rule confirmed

    // apply penalty (debit customer)
    if (penalty > 0) {
      await client.query(`UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`, [penalty, customerWalletId]);
      await client.query(`INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type) VALUES ($1,$2,$3,'DEBIT')`, [customerWalletId, id, penalty]);
    }

    // credit refund to customer
    await client.query(`UPDATE customer_wallets SET balance = balance + $1 WHERE wallet_id=$2`, [refundAmount, customerWalletId]);
    await client.query(`INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type) VALUES ($1,$2,$3,'CREDIT')`, [customerWalletId, id, refundAmount]);

    // deduct provider payout & adjust payouts
    await client.query(`UPDATE provider_wallets SET balance = balance - $1 WHERE serviceproviderid=$2`, [refundAmount, providerBefore]);
    await client.query(`UPDATE payouts SET net_amount = net_amount - $1 WHERE engagement_id=$2`, [refundAmount, id]);

    // Update provider_availability rows:
    // restoredDates -> BOOKED (update slot epochs as required), freedDates -> FREE
    if (restoredDates.length > 0) {
      // compute representative day epoch times
      const repStartTime = epochToTimeHM(oldEng.start_epoch);
      const repEndTime = epochToTimeHM(oldEng.end_epoch);
      for (const day of restoredDates) {
        const ds = toEpochSeconds(day, repStartTime);
        const de = toEpochSeconds(day, repEndTime);
        await client.query(`UPDATE provider_availability SET status='BOOKED', slot_start_epoch=$1, slot_end_epoch=$2 WHERE engagement_id=$3 AND date=$4::date`, [ds, de, id, day]);
      }
    }
    if (freedDates.length > 0) {
      for (const day of freedDates) {
        await client.query(`UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1 AND date=$2::date`, [id, day]);
      }
    }

    // Update engagement row with vacation info
    await client.query(`UPDATE engagements SET vacation_start_date=$1::date, vacation_end_date=$2::date, leave_days=$3 WHERE engagement_id=$4`, [vacationStartDateResolved, vacationEndDateResolved, newLeaveDays, id]);

    // Audit
    const auditEntry = {
      modification_type: prevDates.length === 0 ? "VACATION_ADDED" : "VACATION_MODIFIED",
      previous: prevDates.length > 0 ? { vacation_start_date: prevVacStart ? prevVacStart.toISOString().slice(0,10) : null, vacation_end_date: prevVacEnd ? prevVacEnd.toISOString().slice(0,10) : null, leave_days: prevDates.length } : null,
      updated: { vacation_start_date: vacationStartDateResolved, vacation_end_date: vacationEndDateResolved, leave_days: newLeaveDays, refund: refundAmount },
      difference: { days_added: Math.max(0, newLeaveDays - prevLeaveDays), days_removed: Math.max(0, prevLeaveDays - newLeaveDays), refund_change: refundAmount - (oldEng.refund || 0), penalty },
      wallet_effect: { customer_credit: refundAmount, customer_debit: penalty, provider_debit: refundAmount, payout_adjustment: -refundAmount },
      availability_changes: { dates_freed: freedDates, dates_rebooked: restoredDates }
    };

    await client.query(`INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at) VALUES ($1,$2::jsonb,$3,$4,NOW())`, [id, JSON.stringify(auditEntry), modified_by_id || null, modified_by_role || null]);

    await client.query("COMMIT");
    const updatedEng = (await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])).rows[0];
    updatedEng.start_date = normalizeDateToIST(updatedEng.start_date);
    updatedEng.end_date = normalizeDateToIST(updatedEng.end_date);
    updatedEng.start_time = epochToTimeHM(updatedEng.start_epoch);
    updatedEng.end_time = epochToTimeHM(updatedEng.end_epoch);

    return res.json({ message: "Vacation applied/modified successfully", engagement: updatedEng, audit: auditEntry });

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (e) {}
    console.error("Error updating engagement:", err);
    return res.status(500).json({ error: "Failed to update engagement", detail: err.message });
  } finally {
    client.release();
  }
});

// ----------------- Cancel engagement (simple) -----------------
router.patch("/:id/cancel", async (req, res) => {
  try {
    const result = await pool.query(`UPDATE engagements SET status='cancelled', updated_at=NOW() WHERE engagement_id=$1 RETURNING *`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Engagement not found" });
    // Mark provider availability FREE for this engagement
    await pool.query(`UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1`, [req.params.id]);
    return res.json({ message: "Engagement cancelled", engagement: result.rows[0] });
  } catch (err) {
    console.error("Error cancelling engagement:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------- Accept endpoint (simple) -----------------
router.post("/:id/accept", async (req, res) => {
  const client = await pool.connect();

  try {
    const { serviceproviderid } = req.body;
    const { id } = req.params;

    if (!serviceproviderid) {
      return res.status(400).json({ error: "serviceproviderid is required" });
    }

    await client.query("BEGIN");

    // 1️⃣ Lock engagement
    const engRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`,
      [id]
    );

    if (engRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }

    const e = engRes.rows[0];

    if (e.assignment_status !== "UNASSIGNED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Engagement already assigned" });
    }

    if (!e.start_epoch) {
      throw new Error("Engagement start/end time missing");
    }

    const conflictRow = await findProviderBookedConflict(
      client,
      serviceproviderid,
      e,
      id
    );

    if (conflictRow) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Provider has time conflict",
        detail: `Conflicts with engagement #${conflictRow.engagement_id} on ${conflictRow.date}`,
      });
    }

    // 3️⃣ Assign provider
    await client.query(
      `
      UPDATE engagements
      SET serviceproviderid=$1,
          assignment_status='ASSIGNED'
      WHERE engagement_id=$2
      `,
      [serviceproviderid, id]
    );

    const visitDate =
      calendarYmd(e.start_date) ||
      dayjs.unix(Number(e.start_epoch)).tz("Asia/Kolkata").format("YYYY-MM-DD");

    // 4️⃣ Create provider availability (ONE row)
    await client.query(
      `
      INSERT INTO provider_availability
      (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
      VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())
      `,
      [
        serviceproviderid,
        id,
        visitDate,
        e.start_epoch,
        e.end_epoch,
      ]
    );

    // 5️⃣ Create service_day (ONE row) — visit calendar day in IST
    await client.query(
      `
      INSERT INTO service_days
      (engagement_id, service_date, status, created_at)
      VALUES ($1,$2::date,'SCHEDULED',NOW())
      ON CONFLICT (engagement_id, service_date) DO NOTHING
      `,
      [id, visitDate]
    );

    await client.query("COMMIT");

    // Notify customer (V1 path — same as v2/engagements accept; UI uses /api/engagements/:id/accept)
    try {
      if (req.io) {
        req.io.to(`customer_${e.customerid}`).emit("engagement-accepted", {
          engagement_id: id,
          serviceproviderid: Number(serviceproviderid),
        });
      }
      await createInAppNotification({
        io: req.io,
        recipientType: "customer",
        recipientId: e.customerid,
        type: InAppTypes.BOOKING_ACCEPTED,
        title: "A provider accepted your booking",
        body: `Engagement #${id} is confirmed for ${e.service_type || "your service"}.`,
        engagementId: Number(id),
        metadata: { service_type: e.service_type, serviceproviderid },
      });
    } catch (eNotif) {
      console.error("in-app (V1 /api/engagements/:id/accept) failed", eNotif);
    }

    try {
      await dismissNewBookingInAppByEngagementId(id);
    } catch (eDismiss) {
      console.error("dismiss new-booking in-app (V1 accept) failed", eDismiss);
    }

    // 6️⃣ Return normalized response
    const updated = (
      await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])
    ).rows[0];

    updated.start_time = epochToTimeHM(updated.start_epoch);
    updated.end_time = epochToTimeHM(updated.end_epoch);

    return res.json({
      message: "Engagement accepted successfully",
      engagement: updated,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Accept engagement error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


function getDateRange(startDate, endDate) {
  const dates = [];

  let current = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");

  while (current <= end) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}










export default router;
