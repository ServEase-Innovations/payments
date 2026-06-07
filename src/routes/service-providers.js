import express from "express";
import pool from "../config/db.js";
import { PG_IST_TODAY_DATE } from "../config/istDateSql.js";
import { repairTodayServiceDays } from "./serviceDays.service.js";
import { deriveTaskStatusForProvider } from "../utils/engagementTaskStatus.js";
import { isVisitOverdue } from "../services/overdueStartReminder.service.js";
import { getProviderWalletHistory } from "../services/providerWalletHistory.service.js";
import { redactEngagementForProvider } from "../utils/responseRedaction.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

const router = express.Router();

// Convert epoch → HH:mm (IST)
function epochToTime(epoch) {
  if (!epoch) return null;
  return dayjs.unix(Number(epoch)).tz("Asia/Kolkata").format("HH:mm");
}

// Convert PG date → YYYY-MM-DD
function normalizeDate(dateVal) {
  if (!dateVal) return null;
  return new Date(dateVal).toISOString().slice(0, 10);
}

/** Ensure start/end calendar dates are always present for API consumers. */
function resolveEngagementDates(row) {
  let startDate = normalizeDate(row.start_date);
  let endDate = normalizeDate(row.end_date);

  if (!startDate && row.start_epoch) {
    startDate = dayjs.unix(Number(row.start_epoch)).tz("Asia/Kolkata").format("YYYY-MM-DD");
  }
  if (!endDate && row.end_epoch) {
    endDate = dayjs.unix(Number(row.end_epoch)).tz("Asia/Kolkata").format("YYYY-MM-DD");
  }
  if (!endDate && startDate) {
    endDate = startDate;
  }
  if (!startDate && endDate) {
    startDate = endDate;
  }

  return {
    start_date: startDate,
    end_date: endDate,
    startDate,
    endDate,
  };
}

function ymdToIstStartEpoch(ymd) {
  if (!ymd) return null;
  const d = dayjs.tz(String(ymd).slice(0, 10), "YYYY-MM-DD", "Asia/Kolkata");
  return d.isValid() ? d.startOf("day").unix() : null;
}

function ymdToIstEndEpoch(ymd) {
  if (!ymd) return null;
  const d = dayjs.tz(String(ymd).slice(0, 10), "YYYY-MM-DD", "Asia/Kolkata");
  return d.isValid() ? d.endOf("day").unix() : null;
}

function toFiniteEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function ymdFromEpoch(epochSeconds) {
  const ep = toFiniteEpoch(epochSeconds);
  if (ep == null) return null;
  return dayjs.unix(ep).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

function normalizeYmd(dateLike) {
  if (!dateLike) return null;
  const val = String(dateLike).trim();
  const strict = dayjs.tz(val.slice(0, 10), "YYYY-MM-DD", "Asia/Kolkata");
  if (strict.isValid()) return strict.format("YYYY-MM-DD");
  const parsed = dayjs.tz(val, "Asia/Kolkata");
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
}

/* -------------------------------------------------------------------------- */
/*              TODAY'S BOOKED VISITS (IST calendar day, by start time)       */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/today-bookings", async (req, res) => {
  const pid = Number(req.params.providerId);
  if (!Number.isFinite(pid) || pid < 1) {
    return res.status(400).json({ success: false, error: "Invalid provider id" });
  }

  try {
    const prov = await pool.query(
      `SELECT 1 FROM serviceprovider WHERE serviceproviderid = $1`,
      [pid]
    );
    if (prov.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Provider not found" });
    }

    const paToday = await pool.query(
      `
      SELECT DISTINCT pa.engagement_id
      FROM provider_availability pa
      WHERE pa.serviceproviderid = $1
        AND pa.date = ${PG_IST_TODAY_DATE}
        AND pa.status = 'BOOKED'
        AND pa.engagement_id IS NOT NULL
      UNION
      SELECT DISTINCT e.engagement_id
      FROM engagements e
      WHERE e.serviceproviderid = $1
        AND e.start_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
        AND e.end_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
        AND UPPER(COALESCE(e.engagement_status, '')) NOT IN ('CANCELLED')
        AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED')
      `,
      [pid]
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
          e.customerid,
          e.booking_type,
          e.service_type,
          e.task_status,
          e.engagement_status,
          e.address,
          e.base_amount,
          e.duration_minutes,
          c.firstname,
          c.lastname,
          c.mobileno,
          sd.service_day_id,
          sd.status AS service_day_status
        FROM provider_availability pa
        CROSS JOIN today_ist t
        JOIN engagements e ON e.engagement_id = pa.engagement_id
        JOIN customer c ON c.customerid = e.customerid
        LEFT JOIN LATERAL (
          SELECT s.service_day_id, s.status
          FROM service_days s
          WHERE s.engagement_id = e.engagement_id
            AND s.service_date = pa.date
          ORDER BY s.service_day_id
          LIMIT 1
        ) sd ON true
        WHERE pa.serviceproviderid = $1
          AND pa.date = t.d
          AND pa.status = 'BOOKED'
          AND pa.engagement_id IS NOT NULL
      ),
      assigned_without_slot AS (
        SELECT
          (-e.engagement_id)::bigint AS availability_id,
          e.engagement_id,
          t.d::text AS visit_date,
          e.start_epoch AS slot_start_epoch,
          e.end_epoch AS slot_end_epoch,
          e.start_epoch,
          e.end_epoch,
          'ASSIGNED' AS availability_status,
          e.customerid,
          e.booking_type,
          e.service_type,
          e.task_status,
          e.engagement_status,
          e.address,
          e.base_amount,
          e.duration_minutes,
          c.firstname,
          c.lastname,
          c.mobileno,
          sd.service_day_id,
          sd.status AS service_day_status
        FROM engagements e
        CROSS JOIN today_ist t
        JOIN customer c ON c.customerid = e.customerid
        LEFT JOIN LATERAL (
          SELECT s.service_day_id, s.status
          FROM service_days s
          WHERE s.engagement_id = e.engagement_id
            AND s.service_date = t.d
          ORDER BY s.service_day_id
          LIMIT 1
        ) sd ON true
        WHERE e.serviceproviderid = $1
          AND e.start_date <= t.d
          AND e.end_date >= t.d
          AND UPPER(COALESCE(e.engagement_status, '')) NOT IN ('CANCELLED')
          AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED')
          AND NOT EXISTS (
            SELECT 1
            FROM provider_availability pa2
            WHERE pa2.engagement_id = e.engagement_id
              AND pa2.serviceproviderid = $1
              AND pa2.date = t.d
              AND pa2.status = 'BOOKED'
          )
      )
      SELECT * FROM booked_visits
      UNION ALL
      SELECT * FROM assigned_without_slot
      ORDER BY slot_start_epoch ASC NULLS LAST, availability_id ASC
      `,
      [pid]
    );

    const nowEpoch = dayjs().unix();

    const rows = result.rows.map((row) => {
      const startEp = row.slot_start_epoch != null ? Number(row.slot_start_epoch) : null;
      const endEp = row.slot_end_epoch != null ? Number(row.slot_end_epoch) : null;
      const scheduledStartEpoch = startEp ?? (row.start_epoch != null ? Number(row.start_epoch) : null);
      const overdue = isVisitOverdue({
        scheduledStartEpoch,
        serviceDayStatus: row.service_day_status,
        nowUnix: nowEpoch,
      });
      const overdueMessage = overdue
        ? `This visit was scheduled to start at ${
            scheduledStartEpoch != null
              ? dayjs.unix(scheduledStartEpoch).tz("Asia/Kolkata").format("h:mm A")
              : "the scheduled time"
          } and has not been started yet. Please start the task.`
        : null;
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
        start_time_ist: startEp != null ? epochToTime(startEp) : null,
        end_time_ist: endEp != null ? epochToTime(endEp) : null,
        availability_status: row.availability_status,
        customerid: row.customerid != null ? Number(row.customerid) : null,
        booking_type: row.booking_type,
        service_type: row.service_type,
        task_status: deriveTaskStatusForProvider(
          { task_status: row.task_status, engagement_status: row.engagement_status },
          row.service_day_status
            ? { status: row.service_day_status }
            : null
        ),
        task_status_stored: row.task_status,
        engagement_status: row.engagement_status,
        address: row.address || null,
        base_amount:
          row.base_amount != null ? Number(Number(row.base_amount).toFixed(2)) : null,
        duration_minutes:
          row.duration_minutes != null ? Number(row.duration_minutes) : null,
        customer_firstname: row.firstname || null,
        customer_lastname: row.lastname || null,
        mobileno: row.mobileno || null,
        service_day_id:
          row.service_day_id != null ? Number(row.service_day_id) : null,
        service_day_status: row.service_day_status || null,
        is_overdue: overdue,
        overdue_message: overdueMessage,
      };
    });

    const istDay = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");

    return res.json({
      success: true,
      serviceproviderid: String(pid),
      date: istDay,
      timezone: "Asia/Kolkata",
      count: rows.length,
      bookings: rows,
    });
  } catch (err) {
    console.error("Error fetching provider today-bookings:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*                            PROVIDER PAYOUT SUMMARY                          */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/payouts", async (req, res) => {
  const { providerId } = req.params;
  const { month, detailed } = req.query;

  try {
    const data = await getProviderWalletHistory(providerId, {
      month: month || undefined,
      ledgerOrder: "ASC",
    });

    if (data.notFound) {
      return res.status(404).json({ success: false, error: "Provider not found" });
    }
    if (data.invalidMonth) {
      return res.status(400).json({
        success: false,
        error: "Invalid month format. Use YYYY-MM",
      });
    }

    const response = {
      success: true,
      serviceproviderid: data.serviceproviderid,
      month: data.month,
      summary: data.summary,
    };

    if (detailed === "true") {
      response.ledger = data.ledger;
      response.withdrawals = data.withdrawals;
      response.payouts = data.payouts;
    }

    return res.json(response);
  } catch (err) {
    console.error("Error fetching provider payouts:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                     SP WITHDRAWAL / WALLET HISTORY                          */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/withdrawal-history", async (req, res) => {
  const { providerId } = req.params;
  const { month } = req.query;

  try {
    const data = await getProviderWalletHistory(providerId, {
      month: month || undefined,
      ledgerOrder: "DESC",
    });

    if (data.notFound) {
      return res.status(404).json({ success: false, error: "Provider not found" });
    }
    if (data.invalidMonth) {
      return res.status(400).json({
        success: false,
        error: "Invalid month format. Use YYYY-MM",
      });
    }

    return res.json(data);
  } catch (err) {
    console.error("Error fetching provider withdrawal history:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});





/* -------------------------------------------------------------------------- */
/*                      GET ALL ENGAGEMENTS FOR PROVIDER                      */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/engagements", async (req, res) => {
  const { providerId } = req.params;
  const { status, month } = req.query;

  try {
    let query = `
      SELECT 
        e.engagement_id,
        e.customerid,
        e.serviceproviderid,
        e.start_date,
        e.end_date,
        e.start_epoch,
        e.end_epoch,
        e.responsibilities,
        e.booking_type,
        e.service_type,
        e.task_status,
        e.assignment_status,
        e.engagement_status,
        e.base_amount,
        e.address,
        e.duration_minutes,
        e.created_at,
        e.vacation_start_date,
        e.vacation_end_date,
        e.leave_days,
        c.firstname,
        c.lastname,
        c.mobileno
      FROM engagements e
      JOIN customer c ON e.customerid = c.customerid
      WHERE e.serviceproviderid = $1
    `;

    const params = [providerId];
    let idx = 2;

    if (status) {
      query += ` AND e.task_status = $${idx++}`;
      params.push(status);
    }

    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: "Invalid month format" });
      }
      query += ` AND TO_CHAR(e.start_date,'YYYY-MM') = $${idx++}`;
      params.push(month);
    }

    query += " ORDER BY e.start_date DESC";

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        serviceproviderid: providerId,
        current: [],
        upcoming: [],
        past: []
      });
    }

    const engagementIds = result.rows.map(r => r.engagement_id);

    await repairTodayServiceDays(pool, engagementIds);

    // ---- Fetch today's service days ----
    const todayServiceRes = await pool.query(
      `
      SELECT service_day_id, engagement_id, status
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
    const serviceDayIds = todayServiceRes.rows.map(sd => sd.service_day_id);
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

   // ---- Group engagements ----
const now = dayjs().tz("Asia/Kolkata").unix();
const todayDate = dayjs().tz("Asia/Kolkata").startOf("day");

const current = [];
const upcoming = [];
const past = [];

result.rows.forEach(row => {
  const dates = resolveEngagementDates(row);
  row.startDate = dates.startDate;
  row.endDate = dates.endDate;
  row.start_date = dates.start_date;
  row.end_date = dates.end_date;
  row.startTime = epochToTime(row.start_epoch);
  row.endTime = epochToTime(row.end_epoch);

  const startEpochRaw = Number(row.start_epoch);
  const endEpochRaw = Number(row.end_epoch);
  const startEpoch =
    Number.isFinite(startEpochRaw) && startEpochRaw > 0
      ? startEpochRaw
      : ymdToIstStartEpoch(dates.startDate);
  const endEpoch =
    Number.isFinite(endEpochRaw) && endEpochRaw > 0
      ? endEpochRaw
      : ymdToIstEndEpoch(dates.endDate || dates.startDate);

  const todayService = todayServiceByEng[row.engagement_id] || null;

  // ---- today_service (daily execution state) ----
  let today_service = null;
  if (todayService) {
    const inProgressToday = now >= startEpoch && now < endEpoch;
    const earlyStartSec = 15 * 60;
    const canStartVisit =
      todayService.status === "SCHEDULED" &&
      now >= startEpoch - earlyStartSec &&
      now < endEpoch;

    const sdStatus = String(todayService.status || "").toUpperCase();
    const visitStarted =
      sdStatus === "IN_PROGRESS" || sdStatus === "STARTED" || sdStatus === "COMPLETED";
    today_service = {
      service_day_id: todayService.service_day_id,
      status: todayService.status,
      can_start: canStartVisit && !visitStarted,
      can_generate_otp: visitStarted && sdStatus === "IN_PROGRESS",
      can_complete: sdStatus === "IN_PROGRESS" || sdStatus === "STARTED",
      otp_active: !!otpByServiceDay[todayService.service_day_id],
    };
  }

  const effectiveTaskStatus = deriveTaskStatusForProvider(row, todayService);

  const enriched = redactEngagementForProvider({
    ...row,
    id: row.engagement_id,
    task_status: effectiveTaskStatus,
    start_epoch: startEpoch,
    end_epoch: endEpoch,
    start_date_epoch: ymdToIstStartEpoch(dates.startDate),
    end_date_epoch: ymdToIstEndEpoch(dates.endDate || dates.startDate),
    start_date: dates.start_date,
    end_date: dates.end_date,
    startDate: dates.startDate,
    endDate: dates.endDate,
    address: row.address || null,
    duration_minutes:
      row.duration_minutes != null ? Number(row.duration_minutes) : null,
    today_service,
  });

  // ---- Engagement lifecycle bucket (IMPORTANT) ----
  let bucket;

  if (row.booking_type === "ON_DEMAND") {
    // Time-based
    if (now < startEpoch) {
      bucket = "upcoming";
    } else if (now >= endEpoch) {
      bucket = "past";
    } else {
      bucket = "current";
    }
  } else if (row.booking_type === "SHORT_TERM" || row.booking_type === "MONTHLY") {
    // Date-based
    const engagementStart = dayjs(dates.startDate).startOf("day");
    const engagementEnd = dayjs(dates.endDate || dates.startDate).endOf("day");

    if (todayDate.isBefore(engagementStart)) {
      bucket = "upcoming";
    } else if (todayDate.isAfter(engagementEnd)) {
      bucket = "past";
    } else {
      bucket = "current";
    }
  } else {
    // Safety fallback
    bucket = "past";
  }

  if (bucket === "current") current.push(enriched);
  if (bucket === "upcoming") upcoming.push(enriched);
  if (bucket === "past") past.push(enriched);
});


    return res.json({
      success: true,
      serviceproviderid: providerId,
      current,
      upcoming,
      past
    });

  } catch (err) {
    console.error("Error fetching provider engagements:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});


/* -------------------------------------------------------------------------- */
/*                           PROVIDER CALENDAR API                             */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/calendar", async (req, res) => {
  const { providerId } = req.params;
  const { month, status } = req.query;

  try {
    let query = `
      SELECT 
        id,
        serviceproviderid,
        engagement_id,
        date,
        slot_start_epoch,
        slot_end_epoch,
        status,
        created_at,
        updated_at
      FROM provider_availability
      WHERE serviceproviderid = $1
    `;

    const params = [providerId];
    let idx = 2;

    // Month filter
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month))
        return res.status(400).json({ success: false, error: "Invalid month format" });

      query += ` AND TO_CHAR(date,'YYYY-MM') = $${idx}`;
      params.push(month);
      idx++;
    }

    // Status filter
    if (status) {
      query += ` AND status = $${idx}`;
      params.push(status.toUpperCase());
      idx++;
    }

    query += " ORDER BY date ASC, slot_start_epoch ASC";

    const result = await pool.query(query, params);

    const calendar = result.rows.map((r) => ({
      ...r,
      date: normalizeDate(r.date),
      date_epoch: ymdToIstStartEpoch(normalizeDate(r.date)),
      start_epoch: r.slot_start_epoch != null ? Number(r.slot_start_epoch) : null,
      end_epoch: r.slot_end_epoch != null ? Number(r.slot_end_epoch) : null,
      start_time: epochToTime(r.slot_start_epoch),
      end_time: epochToTime(r.slot_end_epoch),
    }));

    return res.json({
      success: true,
      providerId,
      calendar,
    });
  } catch (err) {
    console.error("Error fetching provider calendar:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*  Engagement modification log (all engagements for this provider)         */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/modification-log", async (req, res) => {
  const { providerId } = req.params;
  const limitRaw = req.query.limit;
  const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), 500);
  try {
    const result = await pool.query(
      `
      SELECT
        m.modification_id,
        m.engagement_id,
        m.modified_at,
        m.created_at,
        m.modified_fields,
        m.modified_by_id,
        m.modified_by_role,
        m.modification_type,
        m.modified_type,
        m.old_start_date,
        m.new_start_date,
        e.start_date AS engagement_start,
        e.end_date AS engagement_end,
        e.service_type,
        e.task_status,
        e.booking_type
      FROM engagement_modifications m
      INNER JOIN engagements e ON e.engagement_id = m.engagement_id
      WHERE e.serviceproviderid = $1
      ORDER BY m.modified_at DESC
      LIMIT $2
    `,
      [providerId, limit]
    );
    const log = result.rows.map((row) => ({
      ...row,
      modified_fields:
        row.modified_fields == null
          ? null
          : typeof row.modified_fields === "string"
            ? JSON.parse(row.modified_fields)
            : row.modified_fields,
      old_start_date: row.old_start_date ? normalizeDate(row.old_start_date) : null,
      new_start_date: row.new_start_date ? normalizeDate(row.new_start_date) : null,
      engagement_start: row.engagement_start ? normalizeDate(row.engagement_start) : null,
      engagement_end: row.engagement_end ? normalizeDate(row.engagement_end) : null,
    }));
    return res.json({ success: true, serviceproviderid: providerId, count: log.length, log });
  } catch (err) {
    console.error("Error fetching provider modification log:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});


router.post("/:providerId/withdraw", async (req, res) => {
  const client = await pool.connect();

  try {
    const { providerId } = req.params;
    const { amount: rawAmount, payout_mode = "BANK" } = req.body;

    const amount = Number(rawAmount);
    if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
      return res.status(400).json({ error: "Invalid withdrawal amount" });
    }
    if (Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid withdrawal amount" });
    }

    await client.query("BEGIN");

    // 1️⃣ Validate provider
    const providerRes = await client.query(
      `SELECT serviceproviderid FROM serviceprovider WHERE serviceproviderid=$1`,
      [providerId]
    );
    if (providerRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Provider not found" });
    }

    // 2️⃣ Lock wallet (auto-create if missing)
    let walletRes = await client.query(
      `SELECT * FROM provider_wallets WHERE serviceproviderid=$1 FOR UPDATE`,
      [providerId]
    );

    if (walletRes.rows.length === 0) {
      await client.query(
        `INSERT INTO provider_wallets (serviceproviderid, balance, security_deposit_collected)
         VALUES ($1, 0, 0)`,
        [providerId]
      );

      walletRes = await client.query(
        `SELECT * FROM provider_wallets WHERE serviceproviderid=$1 FOR UPDATE`,
        [providerId]
      );
    }

    const balance = Number(walletRes.rows[0].balance);

    if (balance < amount) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "Insufficient balance for this withdrawal" });
    }

    // 3️⃣ Charges (customize later)
    const provider_fee = 0;
    const tds_amount = Number((amount * 0.01).toFixed(2));
    const net_amount = amount - provider_fee - tds_amount;

    // 4️⃣ Create payout (PENDING, not SUCCESS)
    const payoutRes = await client.query(
      `
      INSERT INTO payouts (
        serviceproviderid,
        gross_amount,
        provider_fee,
        tds_amount,
        net_amount,
        payout_mode,
        status,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'PENDING',NOW())
      RETURNING *
      `,
      [
        providerId,
        amount,
        provider_fee,
        tds_amount,
        net_amount,
        payout_mode
      ]
    );

    const payout = payoutRes.rows[0];

    // 5️⃣ Insert ledger entry (DEBIT)
    await client.query(
      `
      INSERT INTO provider_ledger
      (serviceproviderid, amount, direction, reason, reference_type, reference_id, created_at)
      VALUES ($1,$2,'DEBIT','WITHDRAWAL','PAYOUT',$3,NOW())
      `,
      [providerId, amount, payout.payout_id]
    );

    // 6️⃣ Deduct wallet balance
    await client.query(
      `
      UPDATE provider_wallets
      SET balance = balance - $1
      WHERE serviceproviderid = $2
      `,
      [amount, providerId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Withdrawal request created",
      payout_id: payout.payout_id,
      requested_amount: amount,
      net_amount,
      remaining_balance: balance - amount
    });

  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore: no open transaction */
    }
    console.error("Withdraw error:", err);
    const msg = err && err.message ? String(err.message) : "Internal server error";
    res.status(500).json({ error: msg });
  } finally {
    client.release();
  }
});

/* -------------------------------------------------------------------------- */
/*  Provider leave requests (provider_leaves)                                  */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/leaves", async (req, res) => {
  const { providerId } = req.params;
  try {
    const result = await pool.query(
      `
      SELECT
        l.leave_id,
        l.serviceproviderid,
        l.engagement_id,
        l.start_date,
        l.end_date,
        l.reason,
        l.status,
        l.created_at
      FROM provider_leaves l
      WHERE l.serviceproviderid = $1
      ORDER BY l.start_date DESC, l.leave_id DESC
      LIMIT 200
      `,
      [providerId]
    );
    return res.json({
      success: true,
      serviceproviderid: providerId,
      leaves: result.rows.map((r) => ({
        ...r,
        start_date: normalizeDate(r.start_date),
        end_date: normalizeDate(r.end_date),
      })),
    });
  } catch (err) {
    console.error("Error fetching provider leaves:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/:providerId/leaves", async (req, res) => {
  const { providerId } = req.params;
  const {
    start_date,
    end_date,
    start_date_epoch,
    end_date_epoch,
    reason,
    engagement_id,
  } = req.body || {};

  const resolvedStartDate = normalizeYmd(start_date) ?? ymdFromEpoch(start_date_epoch);
  const resolvedEndDate = normalizeYmd(end_date) ?? ymdFromEpoch(end_date_epoch);

  if (!resolvedStartDate || !resolvedEndDate) {
    return res
      .status(400)
      .json({ success: false, error: "start_date and end_date are required (YYYY-MM-DD)" });
  }

  const startD = dayjs.tz(resolvedStartDate, "YYYY-MM-DD", "Asia/Kolkata");
  const endD = dayjs.tz(resolvedEndDate, "YYYY-MM-DD", "Asia/Kolkata");
  if (!startD.isValid() || !endD.isValid()) {
    return res.status(400).json({ success: false, error: "Invalid start_date or end_date" });
  }
  if (endD.isBefore(startD, "day")) {
    return res.status(400).json({ success: false, error: "end_date must be on or after start_date" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prov = await client.query(
      "SELECT 1 FROM serviceprovider WHERE serviceproviderid = $1",
      [providerId]
    );
    if (prov.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Provider not found" });
    }

    if (engagement_id) {
      const en = await client.query(
        "SELECT 1 FROM engagements WHERE engagement_id = $1 AND serviceproviderid = $2",
        [engagement_id, providerId]
      );
      if (en.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "engagement not found for this provider" });
      }
    }

    const ins = await client.query(
      `
      INSERT INTO provider_leaves (serviceproviderid, engagement_id, start_date, end_date, reason, status, created_at)
      VALUES ($1, $2, $3::date, $4::date, $5, 'PENDING', NOW())
      RETURNING *
      `,
      [providerId, engagement_id || null, startD.format("YYYY-MM-DD"), endD.format("YYYY-MM-DD"), reason || null]
    );
    await client.query("COMMIT");
    const row = ins.rows[0];
    return res.status(201).json({
      success: true,
      leave: {
        ...row,
        start_date: normalizeDate(row.start_date),
        end_date: normalizeDate(row.end_date),
      },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      // ignore
    }
    console.error("Error creating provider leave:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  } finally {
    client.release();
  }
});

router.delete("/:providerId/leaves/:leaveId", async (req, res) => {
  const { providerId, leaveId } = req.params;
  try {
    const del = await pool.query(
      `
      DELETE FROM provider_leaves
      WHERE leave_id = $1 AND serviceproviderid = $2 AND status = 'PENDING'
      RETURNING leave_id
      `,
      [leaveId, providerId]
    );
    if (del.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Leave not found or not cancellable" });
    }
    return res.json({ success: true, deleted: leaveId });
  } catch (err) {
    console.error("Error deleting provider leave:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*  Ad-hoc day blocks (UNAVAILABLE) — no engagement                            */
/* -------------------------------------------------------------------------- */

function expandDateRangeYmd(startStr, endStr) {
  const s = String(startStr).trim().slice(0, 10);
  const e = String(endStr).trim().slice(0, 10);
  const d = dayjs.tz(s, "YYYY-MM-DD", "Asia/Kolkata").startOf("day");
  const endD = dayjs.tz(e, "YYYY-MM-DD", "Asia/Kolkata").startOf("day");
  if (!d.isValid() || !endD.isValid() || endD.isBefore(d)) return [];
  const out = [];
  let cur = d;
  while (!cur.isAfter(endD)) {
    out.push(cur.format("YYYY-MM-DD"));
    cur = cur.add(1, "day");
  }
  return out;
}

router.get("/:providerId/availability/blocks", async (req, res) => {
  const { providerId } = req.params;
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, error: "Query month=YYYY-MM is required" });
  }
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        serviceproviderid,
        date,
        status,
        slot_start_epoch,
        slot_end_epoch,
        created_at
      FROM provider_availability
      WHERE serviceproviderid = $1
        AND engagement_id IS NULL
        AND UPPER(TRIM(COALESCE(status, ''))) = 'UNAVAILABLE'
        AND TO_CHAR(date, 'YYYY-MM') = $2
      ORDER BY date ASC, id ASC
      `,
      [providerId, month]
    );
    return res.json({
      success: true,
      blocks: result.rows.map((r) => ({
        id: r.id,
        serviceproviderid: r.serviceproviderid,
        date: normalizeDate(r.date),
        date_epoch: ymdToIstStartEpoch(normalizeDate(r.date)),
        status: r.status,
        start_epoch: r.slot_start_epoch != null ? Number(r.slot_start_epoch) : null,
        end_epoch: r.slot_end_epoch != null ? Number(r.slot_end_epoch) : null,
        start_time: epochToTime(r.slot_start_epoch),
        end_time: epochToTime(r.slot_end_epoch),
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Error listing availability blocks:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/:providerId/availability/blocks", async (req, res) => {
  const { providerId } = req.params;
  const {
    start_date,
    end_date,
    start_date_epoch,
    end_date_epoch,
    dates,
    date_epochs,
  } = req.body || {};
  const client = await pool.connect();
  let dateList = [];
  if (Array.isArray(dates) && dates.length) {
    dateList = dates.map((d) => String(d).trim().slice(0, 10)).filter(Boolean);
  } else if (Array.isArray(date_epochs) && date_epochs.length) {
    dateList = date_epochs
      .map((ep) => ymdFromEpoch(ep))
      .filter(Boolean);
  } else if (start_date && end_date) {
    dateList = expandDateRangeYmd(start_date, end_date);
  } else if (start_date_epoch && end_date_epoch) {
    const startYmd = ymdFromEpoch(start_date_epoch);
    const endYmd = ymdFromEpoch(end_date_epoch);
    if (startYmd && endYmd) {
      dateList = expandDateRangeYmd(startYmd, endYmd);
    }
  } else {
    return res
      .status(400)
      .json({ success: false, error: "Send dates[] or { start_date, end_date }" });
  }
  if (dateList.length === 0) {
    return res.status(400).json({ success: false, error: "No valid dates" });
  }
  if (dateList.length > 60) {
    return res.status(400).json({ success: false, error: "Maximum 60 days at once" });
  }

  const created = [];
  const errors = [];
  const todayIst = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");

  try {
    const prov = await client.query("SELECT 1 FROM serviceprovider WHERE serviceproviderid = $1", [
      providerId,
    ]);
    if (prov.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Provider not found" });
    }

    await client.query("BEGIN");
    for (const dayStr of dateList) {
      const dtest = dayjs.tz(dayStr, "YYYY-MM-DD", "Asia/Kolkata");
      const todayStart = dayjs.tz(todayIst, "YYYY-MM-DD", "Asia/Kolkata");
      if (!dtest.isValid() || dtest.isBefore(todayStart, "day")) {
        errors.push({ date: dayStr, error: "PAST_OR_INVALID" });
        continue;
      }
      const booked = await client.query(
        `SELECT 1 AS x FROM provider_availability
         WHERE serviceproviderid = $1 AND date = $2::date AND UPPER(TRIM(COALESCE(status,''))) = 'BOOKED' LIMIT 1`,
        [providerId, dayStr]
      );
      if (booked.rows.length) {
        errors.push({ date: dayStr, error: "DAY_HAS_BOOKING" });
        continue;
      }
      await client.query(
        `DELETE FROM provider_availability
         WHERE serviceproviderid = $1 AND date = $2::date
           AND engagement_id IS NULL
           AND UPPER(TRIM(COALESCE(status,''))) = 'UNAVAILABLE'`,
        [providerId, dayStr]
      );
      const dayStart = dtest.startOf("day").unix();
      const dayEnd = dtest.endOf("day").unix();
      const ins = await client.query(
        `INSERT INTO provider_availability
          (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
         VALUES ($1, NULL, $2::date, $3, $4, 'UNAVAILABLE', NOW(), NOW())
         RETURNING id, date`,
        [providerId, dayStr, dayStart, dayEnd]
      );
      created.push({
        id: ins.rows[0].id,
        date: normalizeDate(ins.rows[0].date),
      });
    }
    await client.query("COMMIT");
    return res.status(201).json({ success: true, created, errors: errors.length ? errors : undefined });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_e) {
      // ignore
    }
    console.error("Error creating availability block:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  } finally {
    client.release();
  }
});

router.delete("/:providerId/availability/blocks/:blockId", async (req, res) => {
  const { providerId, blockId } = req.params;
  try {
    const del = await pool.query(
      `DELETE FROM provider_availability
       WHERE id = $1
         AND serviceproviderid = $2
         AND engagement_id IS NULL
         AND UPPER(TRIM(COALESCE(status,''))) = 'UNAVAILABLE'
       RETURNING id`,
      [blockId, providerId]
    );
    if (del.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Block not found" });
    }
    return res.json({ success: true, deleted: blockId });
  } catch (err) {
    console.error("Error deleting availability block:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
