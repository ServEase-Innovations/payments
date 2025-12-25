import express from "express";
import pool from "../config/db.js";
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

/* -------------------------------------------------------------------------- */
/*                            PROVIDER PAYOUT SUMMARY                          */
/* -------------------------------------------------------------------------- */

router.get("/:providerId/payouts", async (req, res) => {
  const { providerId } = req.params;
  const { month, detailed } = req.query;

  try {
    // 1️⃣ Validate provider
    const providerRes = await pool.query(
      `
      SELECT serviceproviderid, security_deposit_collected
      FROM serviceprovider
      WHERE serviceproviderid = $1
      `,
      [providerId]
    );

    if (providerRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Provider not found",
      });
    }

    const provider = providerRes.rows[0];

    // 2️⃣ Build optional month filter
    let monthFilter = "";
    const params = [providerId];

    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({
          success: false,
          error: "Invalid month format. Use YYYY-MM",
        });
      }
      monthFilter = "AND TO_CHAR(created_at, 'YYYY-MM') = $2";
      params.push(month);
    }

    // 3️⃣ Fetch EARNINGS from provider_ledger
    const ledgerRes = await pool.query(
      `
      SELECT
        ledger_id,
        engagement_id,
        amount,
        reason,
        reference_type,
        reference_id,
        created_at
      FROM provider_ledger
      WHERE serviceproviderid = $1
        AND direction = 'CREDIT'
        ${monthFilter}
      ORDER BY created_at ASC
      `,
      params
    );

    const ledger = ledgerRes.rows;

    // 4️⃣ Fetch WITHDRAWALS from payouts
    const payoutsRes = await pool.query(
      `
      SELECT
        payout_id,
        net_amount,
        status,
        created_at
      FROM payouts
      WHERE serviceproviderid = $1
        AND status = 'SUCCESS'
      `,
      [providerId]
    );

    const payouts = payoutsRes.rows;

    // 5️⃣ Calculate totals
    const totalEarned = ledger.reduce(
      (sum, l) => sum + Number(l.amount || 0),
      0
    );

    const totalWithdrawn = payouts.reduce(
      (sum, p) => sum + Number(p.net_amount || 0),
      0
    );

    const availableToWithdraw = totalEarned - totalWithdrawn;

    const securityDepositPaid =
      Number(provider.security_deposit_collected || 0) >= 5000;

    // 6️⃣ Prepare response
    const response = {
      success: true,
      serviceproviderid: providerId,
      summary: {
        total_earned: Number(totalEarned.toFixed(2)),
        total_withdrawn: Number(totalWithdrawn.toFixed(2)),
        available_to_withdraw: Number(availableToWithdraw.toFixed(2)),
        security_deposit_paid: securityDepositPaid,
        security_deposit_amount: Number(
          provider.security_deposit_collected || 0
        ),
      },
    };

    // 7️⃣ Optional detailed ledger
    if (detailed === "true") {
      response.ledger = ledger.map((l) => ({
        ledger_id: l.ledger_id,
        engagement_id: l.engagement_id,
        amount: Number(l.amount),
        reason: l.reason, // DAILY_EARNED
        reference_type: l.reference_type, // SERVICE_DAY
        reference_id: l.reference_id, // service_day_id
        created_at: l.created_at,
      }));
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
        e.base_amount,
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

    // ---- Fetch today's service days ----
    const todayServiceRes = await pool.query(
      `
      SELECT service_day_id, engagement_id, status
      FROM service_days
      WHERE engagement_id = ANY($1)
        AND service_date = CURRENT_DATE
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
    const today = dayjs().tz("Asia/Kolkata").startOf("day");
    const current = [];
    const upcoming = [];
    const past = [];

    result.rows.forEach(row => {
      row.startDate = normalizeDate(row.start_date);
      row.endDate = normalizeDate(row.end_date);
      row.startTime = epochToTime(row.start_epoch);
      row.endTime = epochToTime(row.end_epoch);

      const engagementStart = dayjs(row.start_date).startOf("day");
      const engagementEnd = dayjs(row.end_date).endOf("day");

      const todayService = todayServiceByEng[row.engagement_id] || null;

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

      const enriched = {
        ...row,
        today_service
      };

      if (today.isBefore(engagementStart)) {
        upcoming.push(enriched);
      } else if (today.isAfter(engagementEnd)) {
        past.push(enriched);
      } else {
        current.push(enriched);
      }
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

export default router;
