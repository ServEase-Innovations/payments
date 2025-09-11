import express from "express";
import pool from "../config/db.js";
import dayjs from "dayjs";

const router = express.Router();

/**
 * GET provider payout summary and details
 * Optional query params: month=YYYY-MM, detailed=true
 */
router.get("/:providerId/payouts", async (req, res) => {
  const { providerId } = req.params;
  const { month, detailed } = req.query;

  try {
    // 1️⃣ Fetch provider wallet and security deposit info
    const providerRes = await pool.query(
      `SELECT serviceproviderid, security_deposit_collected 
       FROM serviceprovider 
       WHERE serviceproviderid=$1`,
      [providerId]
    );

    if (providerRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Provider not found" });
    }

    const provider = providerRes.rows[0];

    // 2️⃣ Prepare date filter safely
    let dateFilter = "";
    let queryParams = [providerId];
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: "Invalid month format. Use YYYY-MM" });
      }

      const startDate = dayjs(`${month}-01`).startOf("month").format("YYYY-MM-DD");
      const endDate = dayjs(`${month}-01`).endOf("month").format("YYYY-MM-DD");

      dateFilter = "AND created_at BETWEEN $2 AND $3";
      queryParams.push(startDate, endDate);
    }

    // 3️⃣ Fetch payouts
    const payoutsRes = await pool.query(
      `SELECT * 
       FROM payouts 
       WHERE serviceproviderid=$1 ${dateFilter} 
       ORDER BY created_at ASC`,
      queryParams
    );

    const payouts = payoutsRes.rows;

    // 4️⃣ Calculate totals
    const totalEarned = payouts.reduce((acc, p) => acc + parseFloat(p.net_amount || 0), 0);
    const totalWithdrawn = payouts
      .filter(p => p.status === "SUCCESS")
      .reduce((acc, p) => acc + parseFloat(p.net_amount || 0), 0);

    const availableToWithdraw = totalEarned - totalWithdrawn;

    const securityDepositPaid = parseFloat(provider.security_deposit_collected || 0) >= 5000;
    const securityDepositAmount = parseFloat(provider.security_deposit_collected || 0);

    // 5️⃣ Prepare response
    const response = {
      success: true,
      serviceproviderid: providerId,
      month: month || null,
      summary: {
        total_earned: totalEarned,
        total_withdrawn: totalWithdrawn,
        available_to_withdraw: availableToWithdraw,
        security_deposit_paid: securityDepositPaid,
        security_deposit_amount: securityDepositAmount,
      },
    };

    if (detailed === "true") {
      response.payouts = payouts.map(p => ({
        payout_id: p.payout_id,
        engagement_id: p.engagement_id,
        gross_amount: parseFloat(p.gross_amount),
        provider_fee: parseFloat(p.provider_fee),
        tds_amount: parseFloat(p.tds_amount),
        net_amount: parseFloat(p.net_amount),
        payout_mode: p.payout_mode,
        status: p.status,
        created_at: p.created_at,
      }));
    }

    return res.json(response);
  } catch (err) {
    console.error("Error fetching provider payouts:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
