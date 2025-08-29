// routes/engagements.js
import express from "express";
import pool from "../config/db.js";
import Razorpay from "razorpay";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

const router = express.Router();



dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");


const razorpay = new Razorpay({
    key_id: "rzp_test_lTdgjtSRlEwreA",
    key_secret: "g15WB8CEwaYBQ5FqpIKKMdNS",
  });

// CREATE engagement
router.post("/", async (req, res) => {
    const client = await pool.connect();
  
    try {
      const {
        customerid,
        serviceproviderid,
        start_date,
        end_date,
        start_time,
        base_amount,
        responsibilities,
        booking_type,
        service_type,
        payment_mode = "razorpay",
      } = req.body;

      const startTimestamp = `${start_date} ${start_time}:00`;
  
      // // Convert camelCase to snake_case for DB
      // const booking_type = bookingType;
      // const service_type = serviceType;
  
      // Calculate Servease amounts
      const platform_fee = base_amount * 0.1;       // 10% of base_amount
      const gst = platform_fee * 0.18;              // 18% GST on platform fee
      const total_amount = base_amount + platform_fee + gst;
  
      await client.query("BEGIN");
  
      // 1️⃣ Insert engagement
      const engagementResult = await client.query(
        `INSERT INTO engagements 
          (customerid, serviceproviderid, start_date, end_date, responsibilities,
           booking_type, service_type, task_status, active, base_amount, created_at, start_time)
         VALUES 
          ($1,$2,$3,$4,$5,$6,$7,'NOT_STARTED', true, $8, NOW(), $9::timestamp)
         RETURNING *`,
        [
          customerid,
          serviceproviderid,
          start_date,
          end_date,
          responsibilities,
          booking_type,
          service_type,
          base_amount,
          startTimestamp
        ]
      );
      const engagement = engagementResult.rows[0];
  
      // 2️⃣ Create Razorpay order if using Razorpay
      let razorpay_order_id = null;
      if (payment_mode === "razorpay") {
        const order = await razorpay.orders.create({
          amount: Math.round(total_amount * 100), // in paise
          currency: "INR",
          receipt: `eng_${engagement.engagement_id}`,
          payment_capture: 1,
        });
        razorpay_order_id = order.id;
      }
  
      // 3️⃣ Insert payment with PENDING status
      const paymentResult = await client.query(
        `INSERT INTO payments
          (engagement_id, base_amount, platform_fee, gst, total_amount, payment_mode, status, razorpay_order_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,NOW())
         RETURNING *`,
        [engagement.engagement_id, base_amount, platform_fee, gst, total_amount, payment_mode, razorpay_order_id]
      );
      const payment = paymentResult.rows[0];
  
      // 4️⃣ Calculate provider payout based on security deposit
      const walletRes = await client.query(
        "SELECT balance, security_deposit_collected FROM provider_wallets WHERE serviceproviderid=$1",
        [serviceproviderid]
      );
      const providerWallet = walletRes.rows[0] || { balance: 0, security_deposit_collected: 0 };
  
      let provider_payout;
      let new_security_deposit = providerWallet.security_deposit_collected;
  
      if (providerWallet.security_deposit_collected < 5000) {
        const remaining_deposit = 5000 - providerWallet.security_deposit_collected;
        const deduction = Math.min(base_amount * 0.1, remaining_deposit);
        provider_payout = base_amount - deduction;
        new_security_deposit += deduction;
      } else {
        provider_payout = base_amount;
      }
  
      // 5️⃣ Update provider wallet
      const updatedWalletRes = await client.query(
        `UPDATE provider_wallets
         SET balance = balance + $1,
             security_deposit_collected = $2
         WHERE serviceproviderid = $3
         RETURNING *`,
        [provider_payout, new_security_deposit, serviceproviderid]
      );
      const updated_wallet = updatedWalletRes.rows[0];
  
      // 6️⃣ Insert payout record
      const payoutResult = await client.query(
        `INSERT INTO payouts
          (serviceproviderid, engagement_id, gross_amount, provider_fee, tds_amount, net_amount, payout_mode, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,'INITIATED', NOW())
         RETURNING *`,
        [serviceproviderid, engagement.engagement_id, base_amount, new_security_deposit - providerWallet.security_deposit_collected, 0, provider_payout]
      );
      const payout = payoutResult.rows[0];
  
      await client.query("COMMIT");
  
      res.status(201).json({
        message: "Engagement, payment, provider wallet, and payout created successfully",
        engagement,
        payment,
        updated_wallet,
        payout,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res.status(500).json({ error: "Failed to create engagement and related records" });
    } finally {
      client.release();
    }
  });
  

// GET /api/engagements - list all engagements
router.get("/", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM engagements ORDER BY created_at DESC");
      res.json(result.rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch engagements" });
    }
  });

  // GET /api/engagements/:id - get engagement by ID

  router.get("/:id", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM engagements WHERE engagement_id=$1", [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: "Engagement not found" });
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch engagement" });
    }
  });

  // PUT /api/engagements/:id - update engagement by ID
  

  // PATCH /api/engagements/:id/cancel - cancel engagement

  router.patch("/:id/cancel", async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE engagements SET status='cancelled', updated_at=NOW() WHERE engagement_id=$1 RETURNING *`,
        [req.params.id]
      );
  
      if (result.rows.length === 0) return res.status(404).json({ error: "Engagement not found" });
      res.json({ message: "Engagement cancelled", engagement: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: "Failed to cancel engagement" });
    }
  });

  // DELETE /api/engagements/:id - delete engagement by ID
  router.delete("/:id", async (req, res) => {
    try {
      const result = await pool.query("DELETE FROM engagements WHERE engagement_id=$1 RETURNING *", [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: "Engagement not found" });
      res.json({ message: "Engagement deleted", engagement: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete engagement" });
    }
  });


  router.put("/:id", async (req, res) => {
    console.log("Modifying engagement with ID:", req.params.id);
    const { id } = req.params;
  
    const {
      start_date,
      end_date,
      start_time,
      end_time,
      responsibilities,
      booking_type,
      service_type,
      task_status,
      active,
      modified_by_id,   // who is making the change
      modified_by_role, // their role: 'customer', 'provider', 'admin'
    } = req.body;
  
    try {
      const setClauses = [];
      const values = [];
      let idx = 1;
  
      if (start_date !== undefined) {
        setClauses.push(`start_date = $${idx++}`);
        values.push(start_date);
      }
      if (end_date !== undefined) {
        setClauses.push(`end_date = $${idx++}`);
        values.push(end_date);
      }
      if (start_time !== undefined) {
        setClauses.push(`start_time = $${idx++}`);
        values.push(start_time);
      }
      if (end_time !== undefined) {
        setClauses.push(`end_time = $${idx++}`);
        values.push(end_time);
      }
      if (responsibilities !== undefined) {
        setClauses.push(`responsibilities = $${idx++}::jsonb`);
        values.push(JSON.stringify(responsibilities));
      }
      if (booking_type !== undefined) {
        setClauses.push(`booking_type = $${idx++}`);
        values.push(booking_type);
      }
      if (service_type !== undefined) {
        setClauses.push(`service_type = $${idx++}`);
        values.push(service_type);
      }
      if (task_status !== undefined) {
        setClauses.push(`task_status = $${idx++}`);
        values.push(task_status);
      }
      if (active !== undefined) {
        setClauses.push(`active = $${idx++}`);
        values.push(active);
      }
  
      if (setClauses.length === 0) {
        return res.status(400).json({ error: "No fields provided for update" });
      }
  
      values.push(id); // engagement_id for WHERE clause
  
      const updateQuery = `
        UPDATE engagements
        SET ${setClauses.join(", ")}
        WHERE engagement_id = $${idx}
        RETURNING *;
      `;
  
      const result = await pool.query(updateQuery, values);
  
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Engagement not found" });
      }
  
      const updatedEngagement = result.rows[0];
  
      // 🔹 Log modification
      await pool.query(
        `
        INSERT INTO engagement_modifications
          (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
        VALUES
          ($1, $2::jsonb, $3, $4, NOW());
        `,
        [id, JSON.stringify(req.body), modified_by_id || null, modified_by_role || null]
      );
  
      res.json(updatedEngagement);
    } catch (err) {
      console.error("Error modifying engagement:", err);
      res.status(500).json({ error: "Failed to update engagement" });
    }
  });
  

  // 📌 Get all engagements (bookings) for a customer
  router.get("/:customerId/engagements", async (req, res) => {
  
    try {
      const { customerId } = req.params;
  
      // Fetch engagements
      const engagementsResult = await pool.query(
        `SELECT * FROM engagements WHERE customerid = $1 ORDER BY start_date ASC`,
        [customerId]
      );
  
      // Fetch modifications for those engagements
      const modificationsResult = await pool.query(
        `SELECT * FROM engagement_modifications 
         WHERE engagement_id = ANY(SELECT engagement_id FROM engagements WHERE customerid = $1)
         ORDER BY modified_at DESC`,
        [customerId]
      );
  
      const now = dayjs().tz("Asia/Kolkata");
      const past = [], ongoing = [], upcoming = [];
  
      // Group modifications by engagement_id
      const modificationsByEngagement = {};
      modificationsResult.rows.forEach(mod => {
        if (!modificationsByEngagement[mod.engagement_id]) {
          modificationsByEngagement[mod.engagement_id] = [];
        }
        modificationsByEngagement[mod.engagement_id].push(mod);
      });
  
      // Categorize engagements + attach modifications
      engagementsResult.rows.forEach((e) => {
        const start = dayjs(e.start_date).tz("Asia/Kolkata");
        const end = dayjs(e.end_date).tz("Asia/Kolkata");
  
        e.modifications = modificationsByEngagement[e.engagement_id] || [];
  
        if (now.isBefore(start)) {
          e.status = "upcoming";
          upcoming.push(e);
        } else if (now.isAfter(end)) {
          e.status = "past";
          past.push(e);
        } else {
          e.status = "ongoing";
          ongoing.push(e);
        }
      });
  
      return res.json({
        success: true,
        upcoming,
        ongoing,
        past
      });
  
    } catch (error) {
      console.error("Error fetching bookings:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });
  
  
  
  
  
  
  

  export default router;
  
  
  
