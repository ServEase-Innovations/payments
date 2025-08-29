import express from "express";
import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

/**
 * Apply vacation / leave for customer
 */
router.post("/:customerId/leaves", async (req, res) => {
  const { customerId } = req.params;
  const { engagement_id, leave_start_date, leave_end_date, leave_type } = req.body;

  try {
    // 1️⃣ Validate dates
    if (!leave_start_date || !leave_end_date) {
      return res.status(400).json({ error: "leave_start_date and leave_end_date are required" });
    }

    const start = dayjs.tz(leave_start_date, "Asia/Kolkata").startOf("day");
    const end = dayjs.tz(leave_end_date, "Asia/Kolkata").endOf("day");

    if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
      return res.status(400).json({ error: "Invalid leave_start_date or leave_end_date" });
    }

    const totalDays = end.diff(start, "day") + 1;

    // 2️⃣ Fetch engagement
    const engagementRes = await pool.query(
      `SELECT * FROM engagements WHERE engagement_id = $1 AND customerid = $2`,
      [engagement_id, customerId]
    );
    if (engagementRes.rows.length === 0) {
      return res.status(404).json({ error: "Engagement not found" });
    }
    const engagement = engagementRes.rows[0];

    // Vacation only allowed for SHORT_TERM or MONTHLY
    if (!["SHORT_TERM", "MONTHLY"].includes(engagement.booking_type)) {
      return res.status(400).json({
        error: "Vacation only applies to SHORT_TERM or MONTHLY bookings",
      });
    }

    // 3️⃣ Calculate refund
    const serviceDays = 30;
    const perDayCost = engagement.base_amount / serviceDays;
    const vacationAmount = perDayCost * totalDays;
    const walletCredit = Math.round(vacationAmount * 0.75);
    const serveaseCut = vacationAmount - walletCredit;

    // 4️⃣ Insert into customer_leaves
    const leaveRes = await pool.query(
      `INSERT INTO customer_leaves
        (customerid, engagement_id, leave_start_date, leave_end_date, leave_type, total_days, refund_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'APPROVED')
       RETURNING *`,
      [customerId, engagement_id, start.toDate(), end.toDate(), leave_type, totalDays, vacationAmount]
    );

    // 5️⃣ Ensure wallet exists
    let walletRes = await pool.query(`SELECT * FROM wallets WHERE customerid = $1`, [customerId]);
    let wallet;
    if (walletRes.rows.length === 0) {
      const newWallet = await pool.query(
        `INSERT INTO wallets (customerid, balance) VALUES ($1,0) RETURNING *`,
        [customerId]
      );
      wallet = newWallet.rows[0];
    } else {
      wallet = walletRes.rows[0];
    }

    // 6️⃣ Update wallet balance
    const newBalance = parseFloat(wallet.balance) + walletCredit;
    await pool.query(`UPDATE wallets SET balance = $1, updated_at = NOW() WHERE wallet_id = $2`, [
      newBalance,
      wallet.wallet_id,
    ]);

    // 7️⃣ Insert wallet transaction
    const txnRes = await pool.query(
      `INSERT INTO wallet_transactions
        (wallet_id, engagement_id, amount, transaction_type, description, balance_after)
       VALUES ($1,$2,$3,'CREDIT',$4,$5)
       RETURNING *`,
      [wallet.wallet_id, engagement_id, walletCredit, `Vacation refund for ${totalDays} days`, newBalance]
    );

    // 8️⃣ Insert into engagement_modifications
    await pool.query(
      `INSERT INTO engagement_modifications
         (engagement_id, modified_at, modified_by, modified_by_role, modified_type, modified_data)
       VALUES ($1, NOW(), $2, $3, 'VACATION', $4)`,
      [
        engagement_id,
        customerId,
        "CUSTOMER",
        JSON.stringify({
          leave_start_date: start.toISOString(),
          leave_end_date: end.toISOString(),
          leave_type,
          total_days: totalDays,
          refund_amount: vacationAmount,
        }),
      ]
    );

    res.status(200).json({
      message: "Vacation applied successfully",
      leave: leaveRes.rows[0],
      refund: { wallet_credit: walletCredit, servease_cut: serveaseCut, vacation_amount: vacationAmount },
      wallet: { wallet_id: wallet.wallet_id, balance: newBalance },
      transaction: txnRes.rows[0],
    });
  } catch (err) {
    console.error("Error applying vacation:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
