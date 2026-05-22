import express from "express";
import pool from "../config/db.js";
import crypto from "crypto";

const router = express.Router();

router.post("/verify", async (req, res) => {
  const {
    engagementId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  } = req.body;

  try {
    // 🔹 DEV / TEST MODE → SKIP SIGNATURE CHECK
    if (process.env.NODE_ENV !== "production") {
      console.log("⚠️ DEV MODE: Skipping Razorpay signature verification");
    } else {
      // 🔐 PROD MODE → VERIFY SIGNATURE
      const body = `${razorpay_order_id}|${razorpay_payment_id}`;

      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: "Invalid payment signature" });
      }
    }

    // ✅ Mark payment SUCCESS
    const payRes = await pool.query(
      `
      UPDATE payments
      SET status='SUCCESS',
          transaction_id=$1,
          updated_at=NOW()
      WHERE razorpay_order_id=$2
      RETURNING *
      `,
      [razorpay_payment_id, razorpay_order_id]
    );

    if (payRes.rows.length === 0) {
      return res.status(404).json({ error: "Payment not found" });
    }

    res.json({
      success: true,
      message: "Payment verified successfully",
      payment: payRes.rows[0],
    });

  } catch (err) {
    console.error("❌ Payment verify error:", err);
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

router.get("/:engagementId/resume", async (req, res) => {
  try {
    const { engagementId } = req.params;

    const result = await pool.query(
      `
      SELECT
        p.payment_id,
        p.razorpay_order_id,
        p.total_amount,
        p.status,
        p.created_at,

        e.engagement_id,
        e.booking_type,
        e.service_type,

        c.customerid,
        c.firstname AS customer_firstname,
        c.lastname AS customer_lastname,
        c.mobileno AS customer_mobile,
        c.emailid AS customer_emailid

      FROM payments p
      JOIN engagements e ON e.engagement_id = p.engagement_id
      JOIN customer c ON c.customerid = e.customerid
      WHERE p.engagement_id = $1
      `,
      [engagementId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Payment not found",
      });
    }

    const payment = result.rows[0];

    if (payment.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        error: "Payment already completed",
      });
    }

    const totalInr = Number(payment.total_amount);
    const amountPaise = Math.round(totalInr * 100);

    return res.json({
      success: true,

      // Razorpay essentials
      razorpay_order_id: payment.razorpay_order_id,
      /** Paise for Razorpay Checkout */
      amount: amountPaise,
      amount_inr: totalInr,
      currency: "INR",

      // Context
      payment_id: payment.payment_id,
      engagement_id: payment.engagement_id,
      engagementId: payment.engagement_id,
      booking_type: payment.booking_type,
      service_type: payment.service_type,
      status: payment.status,
      created_at: payment.created_at,

      customer: {
        customerid: payment.customerid,
        firstname: payment.customer_firstname,
        lastname: payment.customer_lastname,
        contact: payment.customer_mobile,
        mobile: payment.customer_mobile,
        email: payment.customer_emailid,
      },
    });
  } catch (err) {
    console.error("Resume payment error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});





export default router;
