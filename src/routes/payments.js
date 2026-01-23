import express from "express";
import pool from "../config/db.js";
import crypto from "crypto";

const router = express.Router();

router.post("/verify", async (req, res) => {
  const {
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  } = req.body;

  try {
    // 1️⃣ Verify signature (always in prod)
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (generatedSignature !== razorpaySignature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // 2️⃣ Ensure idempotency
    const existing = await pool.query(
      `SELECT status FROM payments WHERE razorpay_order_id=$1`,
      [razorpayOrderId]
    );

    if (existing.rows.length === 0)
      return res.status(404).json({ error: "Payment not found" });

    if (existing.rows[0].status === "SUCCESS") {
      return res.json({ message: "Payment already verified" });
    }

    // 3️⃣ Mark payment SUCCESS
    await pool.query(
      `
      UPDATE payments
      SET status='SUCCESS',
          transaction_id=$1,
          updated_at=NOW()
      WHERE razorpay_order_id=$2
      `,
      [razorpayPaymentId, razorpayOrderId]
    );

    return res.json({ message: "Payment verified successfully" });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Server error" });
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
