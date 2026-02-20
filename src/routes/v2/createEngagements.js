import express from "express";
import pool from "../../config/db.js";
import Razorpay from "razorpay";
import geolib from "geolib";
import { createServiceDays } from "../serviceDays.service.js";
import dayjs from "dayjs";
import { transitionEngagement } from "../../services/engagementLifecycle.js";
import { createHmac } from "crypto";



const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY,
  key_secret: process.env.RAZORPAY_SECRET,
});

function toEpochSeconds(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dt = dayjs.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
  if (!dt.isValid()) return null;
  return dt.unix();
}

router.post("/", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customerid,
      serviceproviderid,
      start_date,
      end_date,
      start_time,
      responsibilities,
      booking_type,
      service_type,
      base_amount,
      latitude,
      longitude,
      payment_mode = "razorpay",
      duration_minutes
    } = req.body;

    if (!customerid || !start_date || !start_time || !base_amount || !booking_type || !service_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const isOnDemand = booking_type === "ON_DEMAND";

    if (!isOnDemand && !serviceproviderid) {
      return res.status(400).json({ error: "Service Provider required" });
    }

    const durationMinutes = duration_minutes || 60;
    const durationSec = durationMinutes * 60;

    const startEpoch = toEpochSeconds(start_date, start_time);
    if (!startEpoch) throw new Error("Invalid start time");

    const endEpoch = startEpoch + durationSec;

    const effectiveEndDate = isOnDemand ? start_date : end_date;

    await client.query("BEGIN");

    // Validate customer
    const cust = await client.query(
      `SELECT customerid FROM customer WHERE customerid=$1`,
      [customerid]
    );
    if (!cust.rows.length) throw new Error("Customer not found");

    const assignment_status = isOnDemand ? "UNASSIGNED" : "ASSIGNED";
    const engagement_status = "PAYMENT_PENDING";

    // ✅ Correct placeholder alignment
    const engagementRes = await client.query(
      `
      INSERT INTO engagements (
        customerid,
        serviceproviderid,
        start_date,
        end_date,
        responsibilities,
        booking_type,
        service_type,
        task_status,
        active,
        base_amount,
        assignment_status,
        engagement_status,
        duration_minutes,
        start_epoch,
        end_epoch,
        created_at
      )
      VALUES (
        $1,$2,$3::date,$4::date,$5,$6,$7,
        'NOT_STARTED',true,$8,$9,$10,$11,$12,$13,NOW()
      )
      RETURNING *
      `,
      [
        customerid,
        isOnDemand ? null : serviceproviderid,
        start_date,
        effectiveEndDate,
        responsibilities,
        booking_type,
        service_type,
        base_amount,
        assignment_status,
        engagement_status,
        durationMinutes,
        startEpoch,
        endEpoch
      ]
    );

    const engagement = engagementRes.rows[0];

    // Lifecycle
    await transitionEngagement(client, {
      engagementId: engagement.engagement_id,
      newStatus: "PAYMENT_PENDING",
      eventType: "ENGAGEMENT_CREATED",
      actorType: "CUSTOMER",
      actorId: customerid,
    });

    // Payment
    const platform_fee = base_amount * 0.1;
    const gst = platform_fee * 0.18;
    const total_amount = base_amount + platform_fee + gst;

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(total_amount * 100),
      currency: "INR",
      receipt: `eng_${engagement.engagement_id}`,
    });

    await client.query(
      `
      INSERT INTO payments
      (engagement_id, base_amount, platform_fee, gst, total_amount,
       payment_mode, status, razorpay_order_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,NOW())
      `,
      [
        engagement.engagement_id,
        base_amount,
        platform_fee,
        gst,
        total_amount,
        payment_mode,
        razorpayOrder.id,
      ]
    );

    await client.query("COMMIT");

    // Notify nearby providers (ON_DEMAND only)
    if (isOnDemand && latitude && longitude) {
      const providers = await pool.query(`
        SELECT serviceproviderid, latitude, longitude
        FROM serviceprovider
        WHERE isactive = true
      `);

      providers.rows.forEach((p) => {
        const distance = geolib.getDistance(
          { latitude, longitude },
          { latitude: p.latitude, longitude: p.longitude }
        );

        if (distance <= 5000) {
          req.io.to(`provider_${p.serviceproviderid}`)
            .emit("new-engagement-request", {
              engagement_id: engagement.engagement_id,
              service_type,
              start_date,
              start_time,
              duration_minutes: durationMinutes,
              base_amount,
            });
        }
      });
    }

    return res.status(201).json({
      success: true,
      engagement_id: engagement.engagement_id,
      razorpay_order_id: razorpayOrder.id,
      total_amount,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("V2 create error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});



import { handlePaymentSuccess } from "../../services/paymentLifecycle.service.js";

router.post("/verify", async (req, res) => {
  try {
    const {
      engagementId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    // 🔐 Optional signature check
    if (process.env.SKIP_RAZORPAY_VERIFY !== "true") {
      const body = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSignature = createHmac(
  "sha256",
  process.env.RAZORPAY_SECRET
)
  .update(body)
  .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: "Invalid signature" });
      }
    }

    await handlePaymentSuccess({
      engagementId,
      razorpay_order_id,
      razorpay_payment_id,
    });

    res.json({ success: true });

  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;

      await handlePaymentSuccess({
        engagementId: payment.notes?.engagementId,
        razorpay_order_id: payment.order_id,
        razorpay_payment_id: payment.id,
        rawEvent: event
      });
    }

    res.json({ received: true });

  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});




export default router;

/**
 * @swagger
 * /v2/createEngagements:
 *   post:
 *     summary: Create a new engagement (V2 Lifecycle)
 *     description: >
 *       Creates an engagement in CREATED state and initiates payment in PENDING state.
 *       
 *       - ON_DEMAND: providerId must NOT be sent. Engagement moves to OPEN_FOR_ACCEPTANCE after payment success.
 *       - MONTHLY / SHORT_TERM: providerId is required. Engagement becomes ASSIGNED after payment success.
 *       
 *       Payment is always created with status PENDING and Razorpay order ID is returned.
 *
 *     tags:
 *       - Engagement V2
 *
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - customerid
 *               - start_date
 *               - start_time
 *               - booking_type
 *               - service_type
 *               - base_amount
 *             properties:
 *               customerid:
 *                 type: integer
 *                 example: 54
 *
 *               serviceproviderid:
 *                 type: integer
 *                 nullable: true
 *                 description: Required for MONTHLY or SHORT_TERM bookings
 *                 example: 4202
 *
 *               booking_type:
 *                 type: string
 *                 enum: [ON_DEMAND, MONTHLY, SHORT_TERM]
 *                 example: ON_DEMAND
 *
 *               service_type:
 *                 type: string
 *                 example: COOK
 *
 *               start_date:
 *                 type: string
 *                 format: date
 *                 example: "2026-02-20"
 *
 *               end_date:
 *                 type: string
 *                 format: date
 *                 description: Required for MONTHLY / SHORT_TERM
 *                 example: "2026-03-20"
 *
 *               start_time:
 *                 type: string
 *                 example: "07:00"
 *
 *               responsibilities:
 *                 type: object
 *                 additionalProperties: true
 *                 example:
 *                   tasks:
 *                     - persons: 2
 *                       taskType: Breakfast
 *
 *               base_amount:
 *                 type: number
 *                 format: float
 *                 example: 2000
 *
 *               latitude:
 *                 type: number
 *                 format: float
 *                 example: 22.5726
 *
 *               longitude:
 *                 type: number
 *                 format: float
 *                 example: 88.3639
 *
 *               payment_mode:
 *                 type: string
 *                 enum: [razorpay]
 *                 default: razorpay
 *
 *     responses:
 *       201:
 *         description: Engagement created successfully (Payment pending)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Engagement created successfully
 *
 *                 engagement:
 *                   type: object
 *                   properties:
 *                     engagement_id:
 *                       type: integer
 *                       example: 142
 *                     engagement_status:
 *                       type: string
 *                       example: PAYMENT_PENDING
 *                     booking_type:
 *                       type: string
 *                       example: ON_DEMAND
 *
 *                 payment:
 *                   type: object
 *                   properties:
 *                     payment_id:
 *                       type: integer
 *                       example: 501
 *                     status:
 *                       type: string
 *                       example: PENDING
 *                     razorpay_order_id:
 *                       type: string
 *                       example: order_S7g8NcfVexBpFq
 *                     total_amount:
 *                       type: number
 *                       example: 2236.00
 *
 *       400:
 *         description: Validation error
 *
 *       500:
 *         description: Internal server error
 */


/**
 * @swagger
 * /v2/createEngagements/verify:
 *   post:
 *     summary: Verify Razorpay payment (Frontend callback)
 *     description: |
 *       Verifies Razorpay payment after checkout.
 *       In production, signature validation is enforced.
 *       In development, signature verification may be skipped.
 *     tags: [Payments V2]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - engagementId
 *               - razorpay_order_id
 *               - razorpay_payment_id
 *             properties:
 *               engagementId:
 *                 type: integer
 *                 example: 144
 *               razorpay_order_id:
 *                 type: string
 *                 example: order_SHUprs7MAU3okk
 *               razorpay_payment_id:
 *                 type: string
 *                 example: pay_SHUrxyz123
 *               razorpay_signature:
 *                 type: string
 *                 example: 9f5d5f6a8e5a...
 *     responses:
 *       200:
 *         description: Payment verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid signature or bad request
 *       404:
 *         description: Payment not found
 *       500:
 *         description: Server error
 */


/**
 * @swagger
 * /v2/createEngagements/webhook:
 *   post:
 *     summary: Razorpay payment webhook
 *     description: |
 *       Receives payment events directly from Razorpay.
 *       This endpoint must be publicly accessible.
 *       Signature verification should be enabled in production.
 *     tags: [Payments V2]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Razorpay webhook event payload
 *             example:
 *               event: payment.captured
 *               payload:
 *                 payment:
 *                   entity:
 *                     id: pay_SHUrxyz123
 *                     order_id: order_SHUprs7MAU3okk
 *                     amount: 1006200
 *                     currency: INR
 *                     status: captured
 *                     notes:
 *                       engagementId: 144
 *     responses:
 *       200:
 *         description: Webhook received successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid webhook signature
 *       500:
 *         description: Server error
 */
