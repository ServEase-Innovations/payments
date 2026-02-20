import express from "express";
import { createHmac } from "crypto";
import pool from "../../config/db.js";
import { transitionEngagement } from "../../services/engagementLifecycle.js";

const router = express.Router();

router.post("/webhook", async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;


  try {
    // 🔐 1️⃣ Verify signature
    const expectedSignature = createHmac("sha256", webhookSecret)
      .update(req.body)
      .digest("hex");

    if (expectedSignature !== signature) {
      console.error("Invalid webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString());

    if (event.event !== "payment.captured") {
      return res.status(200).json({ received: true });
    }

    const paymentEntity = event.payload.payment.entity;

    const razorpayOrderId = paymentEntity.order_id;
    const razorpayPaymentId = paymentEntity.id;

    const client = await pool.connect();
    await client.query("BEGIN");

    // 🔁 2️⃣ Idempotency check
    const paymentRes = await client.query(
      `SELECT * FROM payments WHERE razorpay_order_id=$1 FOR UPDATE`,
      [razorpayOrderId]
    );

    if (!paymentRes.rows.length) {
      throw new Error("Payment record not found");
    }

    const payment = paymentRes.rows[0];

    if (payment.status === "SUCCESS") {
      await client.query("ROLLBACK");
      return res.status(200).json({ message: "Already processed" });
    }

    // 💰 3️⃣ Update payment
    await client.query(
      `
      UPDATE payments
      SET status='SUCCESS',
          transaction_id=$1,
          updated_at=NOW()
      WHERE razorpay_order_id=$2
      `,
      [razorpayPaymentId, razorpayOrderId]
    );

    // 🧠 4️⃣ Fetch engagement
    const engagementRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`,
      [payment.engagement_id]
    );

    const engagement = engagementRes.rows[0];

    if (!engagement) {
      throw new Error("Engagement not found");
    }

    // 🔄 5️⃣ Lifecycle Transition
    if (engagement.booking_type === "ON_DEMAND") {

      await transitionEngagement(client, {
        engagementId: engagement.engagement_id,
        newStatus: "OPEN_FOR_ACCEPTANCE",
        eventType: "PAYMENT_SUCCESS",
        actorType: "SYSTEM",
        actorId: null,
      });

    } else {

      await transitionEngagement(client, {
        engagementId: engagement.engagement_id,
        newStatus: "ASSIGNED",
        eventType: "PAYMENT_SUCCESS",
        actorType: "SYSTEM",
        actorId: null,
      });

    }

    await client.query("COMMIT");

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Webhook failed");
  }
});

export default router;


/**
 * @swagger
 * /v2/payments/webhook:
 *   post:
 *     summary: Razorpay payment webhook
 *     description: >
 *       Receives payment events from Razorpay.
 *       
 *       This endpoint:
 *       - Verifies webhook signature using Razorpay secret
 *       - Updates payment status (SUCCESS / FAILED)
 *       - Triggers engagement lifecycle transition
 *       
 *       Lifecycle behavior:
 *       - ON_DEMAND → transitions to OPEN_FOR_ACCEPTANCE
 *       - MONTHLY / SHORT_TERM → transitions to ASSIGNED
 *       
 *       ⚠️ This endpoint is called only by Razorpay servers.
 *       Signature validation is mandatory.
 *
 *     tags:
 *       - Payments V2
 *
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event:
 *                 type: string
 *                 example: payment.captured
 *
 *               payload:
 *                 type: object
 *                 properties:
 *                   payment:
 *                     type: object
 *                     properties:
 *                       entity:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: pay_S7g8NcfVexBpFq
 *                           order_id:
 *                             type: string
 *                             example: order_S7g8NcfVexBpFq
 *                           amount:
 *                             type: integer
 *                             example: 223600
 *                           currency:
 *                             type: string
 *                             example: INR
 *                           status:
 *                             type: string
 *                             example: captured
 *
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *
 *       400:
 *         description: Invalid webhook signature
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid signature
 *
 *       500:
 *         description: Internal server error
 */

