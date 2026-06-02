import express from "express";
import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

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

function computeDailyRate(baseAmount, startDate, endDate) {
  const totalDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) + 1;
  return Number(baseAmount) / totalDays;
}

async function getCustomerWalletId(client, customerId) {
  const walletRes = await client.query(`SELECT wallet_id, balance FROM customer_wallets WHERE customerid=$1`, [customerId]);
  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(
      `INSERT INTO customer_wallets (customerid, balance) VALUES ($1,0) RETURNING wallet_id, balance`,
      [customerId]
    );
    return insertRes.rows[0];
  }
  return walletRes.rows[0];
}

/**
 * Apply vacation / leave for customer (V1).
 * Prefer POST /api/v2/createEngagements/:engagementId/vacation for full flow (provider availability + payouts).
 */
router.post("/:customerId/leaves", async (req, res) => {
  const { customerId } = req.params;
  const {
    engagement_id,
    leave_start_date,
    leave_end_date,
    leave_start_epoch,
    leave_end_epoch,
    leave_type,
  } = req.body;

  const client = await pool.connect();

  try {
    const resolvedLeaveStartDate =
      normalizeYmd(leave_start_date) ?? ymdFromEpoch(leave_start_epoch);
    const resolvedLeaveEndDate =
      normalizeYmd(leave_end_date) ?? ymdFromEpoch(leave_end_epoch);

    if (!resolvedLeaveStartDate || !resolvedLeaveEndDate) {
      return res.status(400).json({ error: "leave_start_date and leave_end_date are required" });
    }

    const start = dayjs.tz(resolvedLeaveStartDate, "Asia/Kolkata").startOf("day");
    const end = dayjs.tz(resolvedLeaveEndDate, "Asia/Kolkata").endOf("day");

    if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
      return res.status(400).json({ error: "Invalid leave_start_date or leave_end_date" });
    }

    const totalDays = end.diff(start, "day") + 1;

    const engagementRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id = $1 AND customerid = $2`,
      [engagement_id, customerId]
    );
    if (engagementRes.rows.length === 0) {
      return res.status(404).json({ error: "Engagement not found" });
    }
    const engagement = engagementRes.rows[0];

    if (!["SHORT_TERM", "MONTHLY"].includes(engagement.booking_type)) {
      return res.status(400).json({
        error: "Vacation only applies to SHORT_TERM or MONTHLY bookings",
      });
    }

    const dailyRate = computeDailyRate(engagement.base_amount, engagement.start_date, engagement.end_date);
    const refundAmount = Number((dailyRate * totalDays).toFixed(2));

    await client.query("BEGIN");

    const leaveRes = await client.query(
      `INSERT INTO customer_leaves
        (customerid, engagement_id, leave_start_date, leave_end_date, leave_type, total_days, refund_amount, status)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,'APPROVED')
       RETURNING *`,
      [customerId, engagement_id, start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD"), leave_type || "VACATION", totalDays, refundAmount]
    );

    const walletRow = await getCustomerWalletId(client, customerId);
    const walletId = walletRow.wallet_id;

    await client.query(`UPDATE customer_wallets SET balance = balance + $1, updated_at = NOW() WHERE wallet_id = $2`, [
      refundAmount,
      walletId,
    ]);

    const balRes = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id = $1`, [walletId]);
    const newBalance = balRes.rows[0].balance;

    const txnRes = await client.query(
      `INSERT INTO wallet_transaction
        (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
       VALUES ($1,$2,$3,$4,'CREDIT',$5,$6)
       RETURNING *`,
      [
        walletId,
        customerId,
        engagement_id,
        refundAmount,
        `Vacation refund for ${totalDays} day(s)`,
        newBalance,
      ]
    );

    await client.query(
      `INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
       VALUES ($1,$2::jsonb,$3,$4,NOW())`,
      [
        engagement_id,
        JSON.stringify({
          modification_type: "VACATION_ADDED",
          source: "customer_leaves_v1",
          leave_start_date: start.format("YYYY-MM-DD"),
          leave_end_date: end.format("YYYY-MM-DD"),
          total_days: totalDays,
          refund_amount: refundAmount,
        }),
        customerId,
        "CUSTOMER",
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Vacation applied successfully",
      leave: leaveRes.rows[0],
      refund: { wallet_credit: refundAmount, daily_rate: dailyRate, vacation_amount: refundAmount },
      wallet: { wallet_id: walletId, balance: newBalance },
      transaction: txnRes.rows[0],
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (e) {
      /* ignore */
    }
    console.error("Error applying vacation:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  } finally {
    client.release();
  }
});

export default router;
