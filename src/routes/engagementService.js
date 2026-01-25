import express from "express";
const router = express.Router();
import pool from "../config/db.js";
import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);


router.post("/service-days/:id/start", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const sd = await client.query(
      `SELECT * FROM service_days WHERE service_day_id=$1 FOR UPDATE`,
      [id]
    );

    if (sd.rows.length === 0)
      return res.status(404).json({ error: "Service day not found" });

    if (sd.rows[0].status !== "SCHEDULED")
      return res.status(400).json({ error: "Service cannot be started" });

    await client.query(
      `UPDATE service_days
       SET status='IN_PROGRESS', started_at=NOW()
       WHERE service_day_id=$1`,
      [id]
    );

    await client.query("COMMIT");
    res.json({ message: "Service started" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post("/service-days/:id/otp", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // 1️⃣ Validate service day & get customer mobile
    const sdRes = await client.query(
      `
      SELECT sd.status, c.mobileno
      FROM service_days sd
      JOIN engagements e ON e.engagement_id = sd.engagement_id
      JOIN customer c ON c.customerid = e.customerid
      WHERE sd.service_day_id = $1
      FOR UPDATE
      `,
      [id]
    );

    if (sdRes.rows.length === 0)
      return res.status(404).json({ error: "Service day not found" });

    if (sdRes.rows[0].status !== "IN_PROGRESS")
      return res.status(400).json({ error: "OTP allowed only when service is in progress" });

    const mobile = sdRes.rows[0].mobileno;

    // 2️⃣ Check for existing valid OTP (reuse if found)
    const existingOtpRes = await client.query(
      `
      SELECT otp_code
      FROM service_day_otps
      WHERE service_day_id = $1
        AND verified_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [id]
    );

    let otp;

    if (existingOtpRes.rows.length > 0) {
      otp = existingOtpRes.rows[0].otp_code; // 🔁 reuse OTP
    } else {
      // 3️⃣ Generate new OTP (2-hour validity)
      otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // ⏱ 2 hours

      await client.query(
        `
        INSERT INTO service_day_otps (service_day_id, otp_code, expires_at)
        VALUES ($1, $2, $3)
        `,
        [id, otp, expiresAt]
      );
    }

    // 4️⃣ Send OTP via Twilio
    const twilioClient = twilio( process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN );

    await twilioClient.messages.create({
      body: `Your Servease OTP is ${otp}. Valid for 2 hours.`,
      from: "+15803243872",
      to: `+919654754455`,
    });

    await client.query("COMMIT");

    res.json({ otp: otp });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("OTP generation error:", err);
    res.status(500).json({ error: "Failed to send OTP" });
  } finally {
    client.release();
  }
});



router.post("/service-days/:id/complete", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id: serviceDayId } = req.params;
    const { otp } = req.body;

    if (!otp) {
      return res.status(400).json({ error: "OTP is required" });
    }

    await client.query("BEGIN");

    /* 1️⃣ Validate OTP */
    const otpRes = await client.query(
      `
      SELECT otp_id
      FROM service_day_otps
      WHERE service_day_id = $1
        AND otp_code = $2
        AND verified_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [serviceDayId, otp]
    );

    if (otpRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    /* 2️⃣ Lock service day */
    const sdRes = await client.query(
      `
      SELECT
        sd.service_day_id,
        sd.engagement_id,
        sd.status,
        e.serviceproviderid,
        e.base_amount,
        e.start_date,
        e.end_date
      FROM service_days sd
      JOIN engagements e ON e.engagement_id = sd.engagement_id
      WHERE sd.service_day_id = $1
      FOR UPDATE
      `,
      [serviceDayId]
    );

    if (sdRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Service day not found" });
    }

    const sd = sdRes.rows[0];

    if (sd.status !== "IN_PROGRESS") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Service day cannot be completed" });
    }

    if (!sd.serviceproviderid) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Provider not assigned" });
    }

    /* 3️⃣ Calculate daily earning */
    const totalDays =
      (new Date(sd.end_date) - new Date(sd.start_date)) /
        (1000 * 60 * 60 * 24) +
      1;

    const dailyEarning = Number(sd.base_amount) / totalDays;

    /* 4️⃣ Mark OTP verified */
    await client.query(
      `UPDATE service_day_otps SET verified_at = NOW() WHERE otp_id = $1`,
      [otpRes.rows[0].otp_id]
    );

    /* 5️⃣ Complete service day */
    await client.query(
      `
      UPDATE service_days
      SET status = 'COMPLETED',
          completed_at = NOW(),
          otp_verified = true
      WHERE service_day_id = $1
      `,
      [serviceDayId]
    );

    /* 6️⃣ Insert provider ledger (CREDIT) */
    await client.query(
      `
      INSERT INTO provider_ledger
      (serviceproviderid, engagement_id, amount, direction, reason, reference_type, reference_id, created_at)
      VALUES ($1,$2,$3,'CREDIT','DAILY_EARNED','SERVICE_DAY',$4,NOW())
      `,
      [
        sd.serviceproviderid,
        sd.engagement_id,
        dailyEarning,
        serviceDayId,
      ]
    );

    /* 7️⃣ Ensure provider wallet exists */
    await client.query(
      `
      INSERT INTO provider_wallets (serviceproviderid, balance, created_at)
      VALUES ($1, 0, NOW())
      ON CONFLICT (serviceproviderid) DO NOTHING
      `,
      [sd.serviceproviderid]
    );

    /* 8️⃣ Credit provider wallet */
    await client.query(
      `
      UPDATE provider_wallets
      SET balance = balance + $1
      WHERE serviceproviderid = $2
      `,
      [dailyEarning, sd.serviceproviderid]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Service completed & earnings credited",
      earning: Number(dailyEarning.toFixed(2)),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Service day completion error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});




router.get(
  "/engagements/:engagementId/service-days",
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { engagementId } = req.params;

      const result = await client.query(
        `SELECT
           service_day_id,
           engagement_id,
           service_date,
           status,
           started_at,
           completed_at,
           otp_verified
         FROM service_days
         WHERE engagement_id = $1
         ORDER BY service_date`,
        [engagementId]
      );

      res.json({
        success: true,
        engagement_id: Number(engagementId),
        service_days: result.rows,
      });
    } catch (err) {
      console.error("Error fetching service days:", err);
      res.status(500).json({
        success: false,
        error: "Failed to fetch service days",
      });
    } finally {
      client.release();
    }
  }
);


router.get(
  "/engagements/:engagementId/service-days/today",
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { engagementId } = req.params;

      const result = await client.query(
        `SELECT
           service_day_id,
           service_date,
           status
         FROM service_days
         WHERE engagement_id = $1
           AND service_date = CURRENT_DATE
         LIMIT 1`,
        [engagementId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No service scheduled for today",
        });
      }

      res.json({
        success: true,
        service_day: result.rows[0],
      });
    } catch (err) {
      console.error("Error fetching today's service day:", err);
      res.status(500).json({
        success: false,
        error: "Failed to fetch today's service day",
      });
    } finally {
      client.release();
    }
  }
);




export default router;
