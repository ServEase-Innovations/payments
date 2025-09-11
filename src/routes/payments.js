import express from "express";
import pool from "../config/db.js";
import crypto from "crypto";

const router = express.Router();

router.post("/verify", async (req, res) => {
  const { engagementId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  try {
    // DEV mode: skip signature verification
    if (process.env.NODE_ENV !== "production") {
      console.log("⚠️ Skipping Razorpay signature verification (dev mode)");
    } else {
      // Verify Razorpay signature
      const generatedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(razorpayOrderId + "|" + razorpayPaymentId)
        .digest("hex");

      if (generatedSignature !== razorpaySignature) {
        return res.status(400).json({ message: "Invalid payment signature" });
      }
    }

    // Mark payment as SUCCESS
    await pool.query(
      `UPDATE payments SET status='SUCCESS', transaction_id=$1 WHERE razorpay_order_id=$2`,
      [razorpayPaymentId, razorpayOrderId]
    );

    // Fetch payment and engagement details
    const { rows } = await pool.query(
      `SELECT e.serviceproviderid, p.base_amount AS payment_base_amount, p.platform_fee
       FROM payments p
       JOIN engagements e ON e.engagement_id = p.engagement_id
       WHERE p.engagement_id = $1`,
      [engagementId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Payment/Engagement not found" });
    }

    const serviceproviderid = rows[0].serviceproviderid;
    const baseAmount = parseFloat(rows[0].payment_base_amount);
    const providerFee = parseFloat(rows[0].platform_fee);

    // Calculate net amount for provider (consider platform fee)
    const netAmountToProvider = baseAmount - providerFee;

    // Update provider wallet
    await pool.query(
      `UPDATE provider_wallets SET balance = balance + $1 WHERE serviceproviderid=$2`,
      [netAmountToProvider, serviceproviderid]
    );

    // Update engagement status to COMPLETED and set active=false
    await pool.query(
      `UPDATE engagements SET active=false WHERE engagement_id=$1`,
      [engagementId]
    );

    res.json({ message: "Payment verified and completed successfully" });
  } catch (err) {
    console.error("❌ Error in /verify:", err);
    res.status(500).json({ message: "Server error" });
  }
});


router.get("/:providerId/payment-history", async (req, res) => {
  const { providerId } = req.params;

  try {
    const query = `
      SELECT 
        p.payout_id AS id,
        p.engagement_id,
        'CREDIT' AS type,
        p.net_amount AS amount,
        'Payout for engagement #' || p.engagement_id AS description,
        p.created_at AS date,
        p.status
      FROM payouts p
      WHERE p.serviceproviderid = $1
      ORDER BY date DESC;
    `;

    const result = await pool.query(query, [providerId]);

    return res.json({
      success: true,
      providerId,
      history: result.rows,
    });
  } catch (err) {
    console.error("Error fetching payment history:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});




export default router;
