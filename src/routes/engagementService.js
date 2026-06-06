import express from "express";
const router = express.Router();
import pool from "../config/db.js";
import { PG_IST_TODAY_DATE } from "../config/istDateSql.js";
import twilio from "twilio";
import { createInAppNotification, InAppTypes } from "../services/inAppNotification.service.js";
import { dismissOverdueRemindersForEngagement } from "../services/overdueStartReminder.service.js";
import { transitionEngagement } from "../services/engagementLifecycle.js";

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

/** Normalize Indian mobile to E.164 for Twilio (+91…). */
function formatE164Indian(mobile) {
  if (mobile == null || String(mobile).trim() === "") return null;
  const digits = String(mobile).replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("91")) return `+${digits}`;
  return null;
}

/** Best-effort SMS — must not block in-app OTP display for the customer. */
async function sendOtpSmsOptional(mobile, otp) {
  const twilioClient = getTwilioClient();
  if (!twilioClient) {
    return { sent: false, reason: "sms_not_configured" };
  }
  const to = formatE164Indian(mobile);
  if (!to) {
    return { sent: false, reason: "invalid_mobile" };
  }
  try {
    await twilioClient.messages.create({
      body: `Your Servease OTP is ${otp}. Valid for 2 hours.`,
      from: process.env.TWILIO_FROM_NUMBER || "+15803243872",
      to,
    });
    return { sent: true };
  } catch (err) {
    console.error("Twilio OTP SMS failed (non-fatal):", err?.message || err);
    return { sent: false, reason: err?.message || "sms_failed" };
  }
}


router.post("/service-days/:id/start", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const sd = await client.query(
      `SELECT sd.*, e.customerid, e.engagement_id, e.service_type, e.serviceproviderid
       FROM service_days sd
       JOIN engagements e ON e.engagement_id = sd.engagement_id
       WHERE sd.service_day_id = $1
       FOR UPDATE OF sd`,
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

    const row0 = sd.rows[0];
    try {
      await transitionEngagement(client, {
        engagementId: row0.engagement_id,
        newStatus: "IN_PROGRESS",
        eventType: "SERVICE_DAY_STARTED",
        actorType: "PROVIDER",
        actorId: row0.serviceproviderid ?? null,
        metadata: { service_day_id: id },
      });
    } catch (transErr) {
      await client.query(
        `UPDATE engagements
         SET task_status = 'IN_PROGRESS'
         WHERE engagement_id = $1
           AND COALESCE(UPPER(task_status), 'NOT_STARTED') IN ('NOT_STARTED', 'SCHEDULED', '')`,
        [row0.engagement_id]
      );
      console.warn("transitionEngagement on start (non-fatal):", transErr?.message || transErr);
    }

    await client.query("COMMIT");
    try {
      await dismissOverdueRemindersForEngagement(row0.engagement_id);
    } catch (dismissErr) {
      console.warn("dismiss overdue reminders (non-fatal):", dismissErr?.message || dismissErr);
    }
    try {
      await createInAppNotification({
        io: req.io,
        recipientType: "customer",
        recipientId: row0.customerid,
        type: InAppTypes.SERVICE_DAY_STARTED,
        title: "Today’s service has started",
        body: `The provider has started the visit for engagement #${row0.engagement_id}.`,
        engagementId: row0.engagement_id,
        metadata: {
          service_type: row0.service_type,
          service_day_id: id,
        },
      });
    } catch (eNotif) {
      console.error("in-app (service day start) failed", eNotif);
    }

    return res.json({ message: "Service started" });
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
    const serviceDayId = Number(req.params.id);
    if (!Number.isFinite(serviceDayId) || serviceDayId < 1) {
      return res.status(400).json({ error: "Invalid service day id" });
    }

    await client.query("BEGIN");

    const sdRes = await client.query(
      `
      SELECT sd.status, c.mobileno
      FROM service_days sd
      JOIN engagements e ON e.engagement_id = sd.engagement_id
      JOIN customer c ON c.customerid = e.customerid
      WHERE sd.service_day_id = $1
      FOR UPDATE OF sd
      `,
      [serviceDayId]
    );

    if (sdRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Service day not found" });
    }

    const dayStatus = String(sdRes.rows[0].status || "").toUpperCase();
    if (dayStatus !== "IN_PROGRESS" && dayStatus !== "STARTED") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "OTP allowed only when service is in progress",
      });
    }

    const mobile = sdRes.rows[0].mobileno;

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
      [serviceDayId]
    );

    let otp;

    if (existingOtpRes.rows.length > 0) {
      otp = existingOtpRes.rows[0].otp_code;
    } else {
      otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

      await client.query(
        `
        INSERT INTO service_day_otps (service_day_id, otp_code, expires_at)
        VALUES ($1, $2, $3)
        `,
        [serviceDayId, otp, expiresAt]
      );
    }

    await client.query("COMMIT");

    const sms = await sendOtpSmsOptional(mobile, otp);

    res.json({
      otp,
      sms_sent: sms.sent === true,
      message: sms.sent
        ? "OTP generated and sent by SMS"
        : "OTP generated — share it with your provider in the app",
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error("OTP generation error:", err);
    res.status(500).json({
      error: err?.message || "Failed to generate OTP",
    });
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
        e.customerid,
        e.serviceproviderid,
        e.service_type,
        e.booking_type,
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
      INSERT INTO provider_wallets (serviceproviderid, balance, security_deposit_collected)
      VALUES ($1, 0, 0)
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

    const bookingType = String(sd.booking_type || "").toUpperCase();
    const startYmd = String(sd.start_date ?? "").slice(0, 10);
    const endYmd = String(sd.end_date ?? sd.start_date ?? "").slice(0, 10);
    const singleDay = startYmd && endYmd && startYmd === endYmd;

    if (bookingType === "ON_DEMAND" || singleDay) {
      await transitionEngagement(client, {
        engagementId: sd.engagement_id,
        newStatus: "COMPLETED",
        eventType: "SERVICE_DAY_COMPLETED",
        actorType: "PROVIDER",
        actorId: sd.serviceproviderid,
        metadata: { service_day_id: serviceDayId },
      });
    } else {
      await client.query(
        `UPDATE engagements
         SET task_status = 'IN_PROGRESS'
         WHERE engagement_id = $1
           AND COALESCE(UPPER(task_status), 'NOT_STARTED') NOT IN ('COMPLETED', 'CANCELLED')`,
        [sd.engagement_id]
      );
    }

    await client.query("COMMIT");

    const earningLabel = Number(dailyEarning.toFixed(2));
    const completeMeta = {
      service_type: sd.service_type,
      service_day_id: serviceDayId,
      earning: earningLabel,
    };

    try {
      await createInAppNotification({
        io: req.io,
        recipientType: "customer",
        recipientId: sd.customerid,
        type: InAppTypes.SERVICE_DAY_COMPLETED,
        title: "Service visit completed",
        body: `Your visit for engagement #${sd.engagement_id} is marked complete.`,
        engagementId: sd.engagement_id,
        metadata: completeMeta,
      });
    } catch (eNotif) {
      console.error("in-app (service day complete, customer) failed", eNotif);
    }

    try {
      await createInAppNotification({
        io: req.io,
        recipientType: "provider",
        recipientId: sd.serviceproviderid,
        type: InAppTypes.SERVICE_DAY_COMPLETED,
        title: "Service visit completed",
        body: `Visit for engagement #${sd.engagement_id} is complete. ₹${earningLabel} credited to your wallet.`,
        engagementId: sd.engagement_id,
        metadata: completeMeta,
      });
    } catch (eNotif) {
      console.error("in-app (service day complete, provider) failed", eNotif);
    }

    return res.json({
      success: true,
      message: "Service completed & earnings credited",
      earning: Number(dailyEarning.toFixed(2)),
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error("Service day completion error:", err);
    const message = err?.message || "Internal server error";
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : message,
    });
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
      const eid = Number(engagementId);
      if (!Number.isFinite(eid) || eid < 1) {
        return res.status(400).json({ success: false, error: "Invalid engagement id" });
      }

      const eng = await client.query(
        `SELECT 1 FROM engagements WHERE engagement_id = $1`,
        [eid]
      );
      if (eng.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Engagement not found" });
      }

      const selectToday = `
        SELECT service_day_id, service_date, status
        FROM service_days
        WHERE engagement_id = $1
          AND service_date = ${PG_IST_TODAY_DATE}
        LIMIT 1
      `;

      let result = await client.query(selectToday, [eid]);

      if (result.rows.length === 0) {
        // v2 historically created provider_availability but not service_days; repair when a BOOKED visit exists today (IST).
        await client.query(
          `
          INSERT INTO service_days (engagement_id, service_date, status)
          SELECT $1, ${PG_IST_TODAY_DATE}, 'SCHEDULED'
          WHERE EXISTS (
            SELECT 1 FROM provider_availability pa
            WHERE pa.engagement_id = $1
              AND pa.date = ${PG_IST_TODAY_DATE}
              AND pa.status = 'BOOKED'
          )
          ON CONFLICT (engagement_id, service_date) DO NOTHING
          `,
          [eid]
        );
        result = await client.query(selectToday, [eid]);
      }

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
