// routes/engagements.js
import express from "express";
import pool from "../config/db.js";
import Razorpay from "razorpay";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { io } from "../../index.js"; // assuming you set up socket.io in server.js
import geolib from "geolib"; // for distance calculation

const router = express.Router();



dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

// Helper: find providers within 5km
async function findNearbyProviders(lat, lng, radiusKm = 5) {
  const query = `
    SELECT serviceproviderid, firstname, lastname, mobileno, latitude, longitude
    FROM serviceprovider
    WHERE isactive = true
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
  `;
  const result = await pool.query(query);

  // Filter in JS using haversine
  const customerLoc = { lat, lng };
  return result.rows.filter((p) => {
    const providerLoc = { lat: p.latitude, lng: p.longitude };
    const distMeters = haversine(customerLoc, providerLoc);
    return distMeters <= radiusKm * 1000; // within radius
  });
}


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
      start_date,   // "YYYY-MM-DD"
      end_date,     // "YYYY-MM-DD"
      start_time,   // "HH:mm" or "HH:mm AM/PM"
      base_amount,
      responsibilities,
      booking_type,
      service_type,
      latitude,
      longitude,
      payment_mode = "razorpay",
    } = req.body;

    // ✅ Normalize serviceproviderid (0 => null)
    const providerId = serviceproviderid === 0 ? null : serviceproviderid;

    const assignment_status = booking_type === "ON_DEMAND" ? "UNASSIGNED" : "ASSIGNED";

    // 🕒 Parse times
    const startDateTime = new Date(`1970-01-01T${start_time}`);
    if (isNaN(startDateTime.getTime())) {
      return res.status(400).json({ error: "Invalid start_time" });
    }

    // Calculate end_time
    const endDateTime = new Date(startDateTime);
    if (booking_type === "ON_DEMAND") {
      endDateTime.setHours(endDateTime.getHours() + 2);
    } else {
      endDateTime.setHours(endDateTime.getHours() + 1);
    }

    // ✅ Validate times
    if (startDateTime >= endDateTime) {
      return res.status(400).json({ error: "End time must be later than start time" });
    }

    const startTimeFormatted = startDateTime.toISOString().split("T")[1].split(".")[0]; // HH:mm:ss
    const endTimeFormatted = endDateTime.toISOString().split("T")[1].split(".")[0];     // HH:mm:ss

    // 💰 Calculate fees
    const platform_fee = base_amount * 0.1;
    const gst = platform_fee * 0.18;
    const total_amount = base_amount + platform_fee + gst;

    await client.query("BEGIN");

        // ⛔ Conflict check only if provider is assigned (skip for ON_DEMAND UNASSIGNED)
        if (providerId) {
          const conflictCheck = await client.query(
            `SELECT date, start_time, end_time
             FROM provider_availability
             WHERE provider_id = $1
               AND date = $2::date
               AND (tstzrange((date + start_time)::timestamptz, (date + end_time)::timestamptz, '[)') &&
                    tstzrange(($2::date + $3::time)::timestamptz, ($2::date + $4::time)::timestamptz, '[)'))
             LIMIT 1`,
            [providerId, start_date, startTimeFormatted, endTimeFormatted]
          );
    
          if (conflictCheck.rows.length > 0) {
            await client.query("ROLLBACK");
            const conflict = conflictCheck.rows[0];
            return res.status(400).json({
              error: `Provider already has a booking on the selected date and time.`,
            });
          }
        }
    

    // 1️⃣ Insert engagement
    const engagementResult = await client.query(
      `INSERT INTO engagements 
        (customerid, serviceproviderid, start_date, end_date, responsibilities,
         booking_type, service_type, task_status, active, base_amount, created_at, start_time, end_time, assignment_status)
       VALUES 
        ($1,$2,$3::date,$4::date,$5,$6,$7,'NOT_STARTED', true, $8, NOW(), $9::time, $10::time, $11)
       RETURNING *`,
      [
        customerid,
        providerId,
        start_date,
        end_date,
        responsibilities,
        booking_type,
        service_type,
        base_amount,
        startTimeFormatted,
        endTimeFormatted,
        assignment_status
      ]
    );
    const engagement = engagementResult.rows[0];

    // 2️⃣ Razorpay order
    let razorpay_order_id = null;
    if (payment_mode === "razorpay") {
      const order = await razorpay.orders.create({
        amount: Math.round(total_amount * 100),
        currency: "INR",
        receipt: `eng_${engagement.engagement_id}`,
        payment_capture: 1,
      });
      razorpay_order_id = order.id;
    }

    // 3️⃣ Insert payment
    const paymentResult = await client.query(
      `INSERT INTO payments
        (engagement_id, base_amount, platform_fee, gst, total_amount, payment_mode, status, razorpay_order_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,NOW())
       RETURNING *`,
      [engagement.engagement_id, base_amount, platform_fee, gst, total_amount, payment_mode, razorpay_order_id]
    );
    const payment = paymentResult.rows[0];

    // 4️⃣ Provider wallet & payout
    let updated_wallet = null;
    let payout = null;

    if (providerId) {
      const walletRes = await client.query(
        "SELECT balance, security_deposit_collected FROM provider_wallets WHERE serviceproviderid=$1",
        [providerId]
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

      const updatedWalletRes = await client.query(
        `UPDATE provider_wallets
         SET balance = balance + $1,
             security_deposit_collected = $2
         WHERE serviceproviderid = $3
         RETURNING *`,
        [provider_payout, new_security_deposit, providerId]
      );
      updated_wallet = updatedWalletRes.rows[0];

      const payoutResult = await client.query(
        `INSERT INTO payouts
          (serviceproviderid, engagement_id, gross_amount, provider_fee, tds_amount, net_amount, payout_mode, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,'INITIATED', NOW())
         RETURNING *`,
        [
          providerId,
          engagement.engagement_id,
          base_amount,
          new_security_deposit - providerWallet.security_deposit_collected,
          0,
          provider_payout
        ]
      );
      payout = payoutResult.rows[0];

      // 5️⃣ Insert into provider_availability
if (serviceproviderid) {
  if (booking_type === "ON_DEMAND") {
    // Just 1 day slot
    await client.query(
      `INSERT INTO provider_availability
         (provider_id, engagement_id, date, start_time, end_time, status, created_at, updated_at)
       VALUES ($1, $2, $3::date, $4::time, $5::time, 'BOOKED', NOW(), NOW())`,
      [serviceproviderid, engagement.engagement_id, start_date, startTimeFormatted, endTimeFormatted]
    );
  } else {
    // Monthly or Short-term: fill for every day between start_date and end_date
    const start = new Date(start_date);
    const end = new Date(end_date);

    for (
      let d = new Date(start);
      d <= end;
      d.setDate(d.getDate() + 1)
    ) {
      const day = d.toISOString().slice(0, 10); // YYYY-MM-DD
      await client.query(
        `INSERT INTO provider_availability
           (provider_id, engagement_id, date, start_time, end_time, status, created_at, updated_at)
         VALUES ($1, $2, $3::date, $4::time, $5::time, 'BOOKED', NOW(), NOW())`,
        [serviceproviderid, engagement.engagement_id, day, startTimeFormatted, endTimeFormatted]
      );
    }
  }
}
    }

    await client.query("COMMIT");

    // ✅ Step 6: If no provider assigned → notify nearby providers
    if (!providerId && latitude && longitude) {
      const providerRes = await pool.query(
        `SELECT serviceproviderid, firstname, lastname, latitude, longitude
         FROM serviceprovider
         WHERE isactive = true
           AND latitude IS NOT NULL
           AND longitude IS NOT NULL`
      );

      const nearbyProviders = providerRes.rows.filter((p) => {
        const distance = geolib.getDistance(
          { latitude, longitude },
          { latitude: p.latitude, longitude: p.longitude }
        );
        return distance <= 5000; // within 5 km
      });

      console.log("Nearby providers found:", nearbyProviders.length);

      // Send notifications
      nearbyProviders.forEach((p) => {
        io.to(`provider_${p.serviceproviderid}`).emit("new-engagement", {
          engagement: {
            engagement_id: engagement.engagement_id,
            service_type,
            booking_type,
            start_date,
            end_date,
            start_time: startTimeFormatted,
            end_time: endTimeFormatted,
            base_amount,
          },
          payment, // optional: include payment if you want
        });
      });
    }

    res.status(201).json({
      message: "Engagement created successfully",
      engagement,
      payment,
      updated_wallet,
      payout,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating engagement:", error);
    res.status(500).json({ error: "Failed to create engagement" });
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


// Utility: fetch or create customer's wallet_id
async function getCustomerWalletId(client, customerId) {
  const walletRes = await client.query(
    `SELECT wallet_id FROM customer_wallets WHERE customerid=$1`,
    [customerId]
  );

  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(
      `INSERT INTO customer_wallets (customerid, balance)
       VALUES ($1, 0)
       RETURNING wallet_id`,
      [customerId]
    );
    console.log(`✅ Created wallet for customer ${customerId}`);
    return insertRes.rows[0].wallet_id;
  }

  return walletRes.rows[0].wallet_id;
}

// Utility: ensure provider wallet exists
async function ensureProviderWallet(client, providerId) {
  const walletRes = await client.query(
    `SELECT * FROM provider_wallets WHERE serviceproviderid=$1`,
    [providerId]
  );

  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(
      `INSERT INTO provider_wallets (serviceproviderid, balance, security_deposit_collected)
       VALUES ($1, 0, 0)
       RETURNING *`,
      [providerId]
    );
    console.log(`✅ Created wallet for provider ${providerId}`);
    return insertRes.rows[0];
  }

  return walletRes.rows[0];
}

router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    await client.query("BEGIN");

    // 1️⃣ Fetch engagement
    const engRes = await client.query(
      "SELECT * FROM engagements WHERE engagement_id=$1",
      [id]
    );
    if (engRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }
    const oldEng = engRes.rows[0];
    const providerId = oldEng.serviceproviderid;
    const customerId = oldEng.customerid;

    // Ensure wallets exist
    const customerWalletId = await getCustomerWalletId(client, customerId);
    await ensureProviderWallet(client, providerId);

    // 2️⃣ Extract request fields
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
      base_amount,
      vacation_start_date,
      vacation_end_date,
      cancel_vacation,
      modified_by_id,
      modified_by_role
    } = req.body;

    // --- Utility: daily rate ---
    const totalDays =
      (new Date(oldEng.end_date) - new Date(oldEng.start_date)) /
        (1000 * 60 * 60 * 24) +
      1;
    const dailyRate = Number(oldEng.base_amount) / totalDays;

    // --- Vacation Handling ---
    if (vacation_start_date || vacation_end_date || cancel_vacation) {
      const prevLeaveDays = oldEng.leave_days || 0;

      if (cancel_vacation) {
        // ➡️ Cancel leave
        const refundToRevert = prevLeaveDays * dailyRate;

        // Customer wallet (DEBIT)
        await client.query(
          `UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`,
          [refundToRevert, customerWalletId]
        );
        await client.query(
          `INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type)
           VALUES ($1,$2,$3,'DEBIT')`,
          [customerWalletId, id, refundToRevert]
        );

        // Provider wallet (CREDIT)
        await client.query(
          `UPDATE provider_wallets SET balance = balance + $1 WHERE serviceproviderid=$2`,
          [refundToRevert, providerId]
        );

        // Update payouts
        await client.query(
          `UPDATE payouts SET net_amount = net_amount + $1 WHERE engagement_id=$2`,
          [refundToRevert, id]
        );

        // Restore provider availability
        await client.query(
          `UPDATE provider_availability SET status='BOOKED' WHERE engagement_id=$1`,
          [id]
        );

        // Log modification
        await client.query(
          `INSERT INTO engagement_modifications
           (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
           VALUES ($1,$2::jsonb,$3,$4,NOW())`,
          [id, JSON.stringify({ cancel_vacation: true }), modified_by_id, modified_by_role]
        );

      } else {
        // ➡️ Apply or modify leave
        const vacStart = new Date(vacation_start_date || oldEng.vacation_start_date);
        const vacEnd = new Date(vacation_end_date || oldEng.vacation_end_date);

        const leaveDays = (vacEnd - vacStart) / (1000 * 60 * 60 * 24) + 1;
        const refundAmount = leaveDays * dailyRate;

        let penalty = 0;
        if (prevLeaveDays > 0) {
          // Modification case → apply ₹400 penalty
          penalty = 400;

          await client.query(
            `UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`,
            [penalty, customerWalletId]
          );
          await client.query(
            `INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type)
             VALUES ($1,$2,$3,'DEBIT')`,
            [customerWalletId, id, penalty]
          );
        }

        // Refund to customer (CREDIT)
        await client.query(
          `UPDATE customer_wallets SET balance = balance + $1 WHERE wallet_id=$2`,
          [refundAmount, customerWalletId]
        );
        await client.query(
          `INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type)
           VALUES ($1,$2,$3,'CREDIT')`,
          [customerWalletId, id, refundAmount]
        );

        // Deduct provider payout
        await client.query(
          `UPDATE provider_wallets SET balance = balance - $1 WHERE serviceproviderid=$2`,
          [refundAmount, providerId]
        );

        // Update payouts
        await client.query(
          `UPDATE payouts SET net_amount = net_amount - $1 WHERE engagement_id=$2`,
          [refundAmount, id]
        );

        // Free provider availability
        await client.query(
          `UPDATE provider_availability
           SET status='FREE'
           WHERE engagement_id=$1
             AND date BETWEEN $2::date AND $3::date`,
          [id, vacStart, vacEnd]
        );

        // Update engagement with leave info
        await client.query(
          `UPDATE engagements
           SET vacation_start_date=$1, vacation_end_date=$2, leave_days=$3
           WHERE engagement_id=$4`,
          [vacStart, vacEnd, leaveDays, id]
        );

        // Log modification
        await client.query(
          `INSERT INTO engagement_modifications
           (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
           VALUES ($1,$2::jsonb,$3,$4,NOW())`,
          [
            id,
            JSON.stringify({
              vacation_start_date: vacStart,
              vacation_end_date: vacEnd,
              leave_days: leaveDays,
              refund: refundAmount,
              penalty
            }),
            modified_by_id,
            modified_by_role
          ]
        );
      }

    } else {
      // --- Normal engagement update ---
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
        setClauses.push(`start_time = $${idx++}::time`);
        values.push(start_time);
      }
      if (end_time !== undefined) {
        setClauses.push(`end_time = $${idx++}::time`);
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
      if (base_amount !== undefined) {
        setClauses.push(`base_amount = $${idx++}`);
        values.push(base_amount);
      }

      if (setClauses.length > 0) {
        values.push(id);
        await client.query(
          `UPDATE engagements SET ${setClauses.join(", ")} WHERE engagement_id=$${idx}`,
          values
        );
      }

      // Log modification
      await client.query(
        `INSERT INTO engagement_modifications
         (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
         VALUES ($1,$2::jsonb,$3,$4,NOW())`,
        [id, JSON.stringify(req.body), modified_by_id, modified_by_role]
      );
    }

    await client.query("COMMIT");

    // Fetch updated engagement
    const updatedRes = await pool.query(
      "SELECT * FROM engagements WHERE engagement_id=$1",
      [id]
    );

    res.json({
      message: "Engagement updated successfully",
      engagement: updatedRes.rows[0]
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating engagement:", err);
    res.status(500).json({ error: "Failed to update engagement" });
  } finally {
    client.release();
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


  router.post("/:id/accept", async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { provider_id } = req.body;
  
      await client.query("BEGIN");
  
      // Lock engagement row to prevent race conditions
      const engagementRes = await client.query(
        `SELECT * FROM engagements 
         WHERE engagement_id = $1
         FOR UPDATE`,
        [id]
      );
  
      if (engagementRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Engagement not found" });
      }
  
      const engagement = engagementRes.rows[0];
  
      if (engagement.assignment_status !== "UNASSIGNED") {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, error: "Engagement already assigned" });
      }
  
      // ✅ Assign to provider
      const updateRes = await client.query(
        `UPDATE engagements
         SET serviceproviderid = $1, assignment_status = 'ASSIGNED'
         WHERE engagement_id = $2
         RETURNING *`,
        [provider_id, id]
      );
  
      const updatedEngagement = updateRes.rows[0];
  
      // Insert into provider_availability (mark booked)
      await client.query(
        `INSERT INTO provider_availability 
          (provider_id, engagement_id, date, start_time, end_time, status, created_at, updated_at)
         VALUES ($1, $2, $3::date, $4::time, $5::time, 'BOOKED', NOW(), NOW())`,
        [
          provider_id,
          updatedEngagement.engagement_id,
          updatedEngagement.start_date,
          updatedEngagement.start_time,
          updatedEngagement.end_time,
        ]
      );
  
      await client.query("COMMIT");
  
      // 🔔 Notify winner
      sendToProvider(provider_id, {
        type: "ENGAGEMENT_ASSIGNED",
        engagement: updatedEngagement,
      });
  
      // 🔔 Optionally notify others (losers)
      // broadcastToOthers(provider_id, { type: "ALREADY_ASSIGNED", engagement_id: id });
  
      return res.json({
        success: true,
        message: "Engagement assigned successfully",
        engagement: updatedEngagement,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error accepting engagement:", err);
      return res.status(500).json({ success: false, error: "Internal server error" });
    } finally {
      client.release();
    }
  });


  router.patch("/:id/accept", async (req, res) => {
    const client = await pool.connect();
    try {
      const engagementId = req.params.id;
      const { providerId } = req.body;
  
      if (!providerId) {
        return res.status(400).json({ error: "providerId is required" });
      }
  
      await client.query("BEGIN");
  
      // 🔍 Fetch engagement
      const engRes = await client.query(
        `SELECT * FROM engagements WHERE engagement_id = $1 FOR UPDATE`,
        [engagementId]
      );
      const engagement = engRes.rows[0];
  
      if (!engagement) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Engagement not found" });
      }
  
      if (engagement.assignment_status !== "UNASSIGNED") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Engagement already assigned" });
      }
  
      // ✅ Update engagement with provider
      const updateRes = await client.query(
        `UPDATE engagements
         SET serviceproviderid = $1,
             assignment_status = 'ASSIGNED'
         WHERE engagement_id = $2
         RETURNING *`,
        [providerId, engagementId]
      );
      const updatedEngagement = updateRes.rows[0];
  
      // ✅ Insert into provider_availability
      await client.query(
        `INSERT INTO provider_availability
           (provider_id, engagement_id, date, start_time, end_time, status, created_at, updated_at)
         VALUES ($1, $2, $3::date, $4::time, $5::time, 'BOOKED', NOW(), NOW())`,
        [
          providerId,
          engagementId,
          engagement.start_date,
          engagement.start_time,
          engagement.end_time,
        ]
      );
  
      await client.query("COMMIT");
  
      return res.json({
        success: true,
        message: "Engagement accepted successfully",
        engagement: updatedEngagement,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error accepting engagement:", err);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });
  
  
  
  
  
  
  

  export default router;
  
  
  
