import express from "express";
import pool from "../../config/db.js";
import Razorpay from "razorpay";
import geolib from "geolib";
import { createServiceDays } from "../serviceDays.service.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { transitionEngagement } from "../../services/engagementLifecycle.js";
import { applyVacationForEngagement } from "../../services/vacationApply.service.js";
import { createHmac } from "crypto";

/**
 * V2 SP-backed engagement → calendar booking
 *
 * 1. **POST** `/api/v2/createEngagements` creates an `engagements` row (MONTHLY/SHORT_TERM with `serviceproviderid`) in **PAYMENT_PENDING**
 *    plus a PENDING payment and Razorpay order.
 * 2. **Payment success** (`POST /verify` or `/webhook` → `handlePaymentSuccess`) marks payment SUCCESS and calls
 *    **`transitionEngagement`** to **ASSIGNED** (non–ON_DEMAND).
 * 3. **`transitionEngagement`** (`engagementLifecycle.js`): when new status is **ASSIGNED** and a SP is set,
 *    inserts **`provider_availability`** rows — one per calendar day from `start_date` … `end_date`, each
 *    **BOOKED** with `slot_start_epoch` / `slot_end_epoch` derived from `start_epoch` wall time + `duration_minutes`.
 *
 * **Vacation** (`POST /:engagementId/vacation` → `applyVacationForEngagement`): frees PA rows for the vacation
 * date range (**FREE**, null epochs), updates `engagements` vacation fields, and credits the customer wallet
 * (daily rate × leave days; modification penalty may apply).
 */

const router = express.Router();

// Configure dayjs with timezone support (same as legacy engagements route)
dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY,
  key_secret: process.env.RAZORPAY_SECRET,
});

/** One visit cannot exceed 24h; prevents bad payloads (e.g. minutes ≈ contract length) from breaking overlap logic. */
const MAX_SERVICE_DURATION_MINUTES = 24 * 60;

function toEpochSeconds(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dt = dayjs.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
  if (!dt.isValid()) return null;
  return dt.unix();
}

/**
 * Same-calendar-day visit length from wall-clock times (IST). Used when `duration_minutes`
 * looks like a contract length (e.g. 43260) so overlap checks use the real daily window.
 */
function visitDurationMinutesFromClock(dateStr, startTime, endTime) {
  if (!dateStr || !startTime || !endTime) return null;
  const a = toEpochSeconds(dateStr, startTime);
  const b = toEpochSeconds(dateStr, endTime);
  if (a == null || b == null || b <= a) return null;
  const mins = (b - a) / 60;
  if (!Number.isFinite(mins) || mins < 15) return null;
  if (mins > MAX_SERVICE_DURATION_MINUTES) return null;
  return Math.round(mins);
}

/**
 * Read-only: inspect why create might block — lists provider_availability + engagements for a date.
 * GET /api/v2/createEngagements/providers/:providerId/booking-debug?date=2026-04-09&start_time=07:00&duration_minutes=60
 */
router.get("/providers/:providerId/booking-debug", async (req, res) => {
  try {
    const providerId = parseInt(req.params.providerId, 10);
    const { date, start_time = "07:00", duration_minutes } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: "Query param `date` (YYYY-MM-DD) is required" });
    }
    if (!Number.isFinite(providerId)) {
      return res.status(400).json({ error: "Invalid providerId" });
    }

    const rawDur =
      duration_minutes != null && Number.isFinite(Number(duration_minutes))
        ? Number(duration_minutes)
        : 60;
    const durationMinutes = Math.min(
      Math.max(rawDur, 15),
      MAX_SERVICE_DURATION_MINUTES
    );
    const durationSec = durationMinutes * 60;

    const dayWindowStart = toEpochSeconds(String(date), "00:00");
    const dayWindowEnd = dayWindowStart != null ? dayWindowStart + 86400 : null;
    const reqStart = toEpochSeconds(String(date), String(start_time));
    const reqEnd = reqStart != null ? reqStart + durationSec : null;

    const paAll = await pool.query(
      `
      SELECT id, engagement_id, date, status,
             slot_start_epoch, slot_end_epoch,
             (slot_end_epoch - slot_start_epoch) / 60.0 AS span_minutes_raw
      FROM provider_availability
      WHERE serviceproviderid = $1 AND date = $2::date
      ORDER BY id
      `,
      [providerId, date]
    );

    let conflictingRows = [];
    if (
      dayWindowStart != null &&
      dayWindowEnd != null &&
      reqStart != null &&
      reqEnd != null
    ) {
      const clash = await pool.query(
        `
        SELECT id, engagement_id, date, status, slot_start_epoch, slot_end_epoch
        FROM provider_availability
        WHERE serviceproviderid = $1
          AND status = 'BOOKED'
          AND date = $2::date
          AND slot_start_epoch IS NOT NULL
          AND slot_end_epoch IS NOT NULL
          AND GREATEST(slot_start_epoch, $5::bigint) < LEAST(slot_end_epoch, $6::bigint)
          AND $3::bigint < LEAST(slot_end_epoch, $6::bigint)
          AND $4::bigint > GREATEST(slot_start_epoch, $5::bigint)
        `,
        [providerId, date, reqStart, reqEnd, dayWindowStart, dayWindowEnd]
      );
      conflictingRows = clash.rows;
    }

    const engagements = await pool.query(
      `
      SELECT engagement_id, customerid, start_date, end_date, booking_type,
             engagement_status, assignment_status, active, duration_minutes,
             start_epoch, end_epoch
      FROM engagements
      WHERE serviceproviderid = $1
        AND active = true
        AND start_date <= $2::date
        AND end_date >= $2::date
      ORDER BY engagement_id
      `,
      [providerId, date]
    );

    const clipped = paAll.rows.map((r) => {
      if (
        r.slot_start_epoch == null ||
        r.slot_end_epoch == null ||
        dayWindowStart == null ||
        dayWindowEnd == null
      ) {
        return { ...r, clipped_start_epoch: null, clipped_end_epoch: null };
      }
      const cs = Math.max(Number(r.slot_start_epoch), dayWindowStart);
      const ce = Math.min(Number(r.slot_end_epoch), dayWindowEnd);
      const overlapsRequest =
        reqStart != null &&
        reqEnd != null &&
        cs < ce &&
        reqStart < ce &&
        reqEnd > cs;
      return {
        ...r,
        clipped_start_epoch: cs < ce ? cs : null,
        clipped_end_epoch: cs < ce ? ce : null,
        overlaps_request_slot: overlapsRequest && r.status === "BOOKED",
      };
    });

    return res.json({
      provider_id: providerId,
      date: String(date),
      query: {
        start_time: String(start_time),
        duration_minutes_requested: rawDur,
        duration_minutes_effective: durationMinutes,
        note:
          rawDur > MAX_SERVICE_DURATION_MINUTES
            ? `duration_minutes was clamped to ${MAX_SERVICE_DURATION_MINUTES} (same as create)`
            : null,
      },
      ist_day_window_epoch: { start: dayWindowStart, end: dayWindowEnd },
      request_slot_epoch: { start: reqStart, end: reqEnd },
      would_block_create: conflictingRows.length > 0,
      conflicting_booked_rows: conflictingRows,
      provider_availability_all_statuses: clipped,
      engagements_covering_date: engagements.rows,
    });
  } catch (err) {
    console.error("booking-debug error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customerid,
      serviceproviderid,
      start_date,
      end_date,
      start_time,
      end_time,
      responsibilities,
      booking_type,
      service_type,
      base_amount,
      address,
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

    const rawDur =
      duration_minutes != null && Number.isFinite(Number(duration_minutes))
        ? Number(duration_minutes)
        : 60;
    let durationMinutes = Math.min(
      Math.max(rawDur, 15),
      MAX_SERVICE_DURATION_MINUTES
    );
    if (rawDur > MAX_SERVICE_DURATION_MINUTES) {
      const fromClock = visitDurationMinutesFromClock(
        start_date,
        start_time,
        end_time
      );
      if (fromClock != null) {
        durationMinutes = fromClock;
      }
    }
    const durationSec = durationMinutes * 60;

    const startEpoch = toEpochSeconds(start_date, start_time);
    if (!startEpoch) throw new Error("Invalid start time");

    const endEpoch = startEpoch + durationSec;

    const effectiveEndDate = isOnDemand ? start_date : end_date;

    await client.query("BEGIN");

    // Overlap check: clip existing slots to this calendar day (IST). Rows sometimes store
    // multi-day spans from bad duration_minutes; raw epoch overlap then falsely blocks bookings.
    if (!isOnDemand && serviceproviderid) {
      const startD = new Date(start_date);
      const endD = new Date(effectiveEndDate);
      for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
        const day = d.toISOString().slice(0, 10);
        const dayWindowStart = toEpochSeconds(day, "00:00");
        if (dayWindowStart == null) continue;
        const dayWindowEnd = dayWindowStart + 86400;
        const dayStartEpoch = toEpochSeconds(day, start_time);
        if (dayStartEpoch == null) continue;
        const dayEndEpoch = dayStartEpoch + durationSec;
        const overlap = await client.query(
          `SELECT 1 FROM provider_availability
           WHERE serviceproviderid = $1
             AND status = 'BOOKED'
             AND date = $2::date
             AND slot_start_epoch IS NOT NULL
             AND slot_end_epoch IS NOT NULL
             AND GREATEST(slot_start_epoch, $5::bigint) < LEAST(slot_end_epoch, $6::bigint)
             AND $3::bigint < LEAST(slot_end_epoch, $6::bigint)
             AND $4::bigint > GREATEST(slot_start_epoch, $5::bigint)
           LIMIT 1`,
          [
            serviceproviderid,
            day,
            dayStartEpoch,
            dayEndEpoch,
            dayWindowStart,
            dayWindowEnd,
          ]
        );
        if (overlap.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Provider already has a booking at this time",
            detail: `Service provider ${serviceproviderid} is booked on ${day} at the selected time slot (${start_time}).`,
          });
        }
      }
    }

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
        address,
        latitude,
        longitude,
        created_at
      )
      VALUES (
        $1,$2,$3::date,$4::date,$5,$6,$7,
        'NOT_STARTED',true,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW()
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
        endEpoch,
        address || null,
        latitude,
        longitude
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
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
      `);

      for (const p of providers.rows) {
        if (p.latitude == null || p.longitude == null) continue;

        const distance = geolib.getDistance(
          { latitude: Number(latitude), longitude: Number(longitude) },
          { latitude: Number(p.latitude), longitude: Number(p.longitude) }
        );

        if (distance <= 5000) {
          req.io.to(`provider_${p.serviceproviderid}`).emit("new-engagement", {
            engagement_id: engagement.engagement_id,
            service_type,
            start_date,
            start_time,
            duration_minutes: durationMinutes,
            base_amount,
          });
        }
      }
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

/**
 * Apply vacation for a MONTHLY / SHORT_TERM engagement (same rules as PUT `/api/engagements/:id` vacation).
 * Frees SP time in `provider_availability` and credits customer wallet.
 *
 * POST /api/v2/createEngagements/:engagementId/vacation
 */
router.post("/:engagementId/vacation", async (req, res) => {
  const client = await pool.connect();

  try {
    const engagementId = Number(req.params.engagementId);
    const {
      customerid,
      vacation_start_date,
      vacation_end_date,
      leave_type,
      modified_by_id,
      modified_by_role,
    } = req.body || {};

    if (!Number.isFinite(engagementId) || engagementId < 1) {
      return res.status(400).json({ success: false, error: "Invalid engagementId" });
    }
    if (!customerid || !vacation_start_date || !vacation_end_date) {
      return res.status(400).json({
        success: false,
        error: "customerid, vacation_start_date, and vacation_end_date are required",
      });
    }

    await client.query("BEGIN");

    const result = await applyVacationForEngagement(client, {
      engagementId,
      customerId: customerid,
      vacationStartDate: vacation_start_date,
      vacationEndDate: vacation_end_date,
      leaveType: leave_type || "VACATION",
      modifiedById: modified_by_id != null ? modified_by_id : customerid,
      modifiedByRole: modified_by_role || "CUSTOMER",
    });

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Vacation applied successfully",
      engagement: result.engagement,
      refund_amount: result.refund_amount,
      penalty: result.penalty,
      wallet_balance: result.wallet_balance,
      audit: result.audit,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const code = err.statusCode || 500;
    console.error("V2 createEngagements vacation error:", err);
    return res.status(code).json({
      success: false,
      error: err.message,
      conflicts: err.conflicts,
      conflict: err.conflict,
    });
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
      io: req.io, // Pass Socket.IO instance for real-time updates
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

/**
 * @swagger
 * /v2/createEngagements/{engagementId}/vacation:
 *   post:
 *     summary: Apply vacation (V2 under create-engagements path)
 *     description: |
 *       MONTHLY or SHORT_TERM with assigned SP only.
 *       Sets `provider_availability` to FREE for each vacation day, updates engagement vacation columns,
 *       credits `customer_wallets` (daily rate × days; ₹400 penalty when modifying an existing vacation).
 *     tags:
 *       - Engagement V2
 *     parameters:
 *       - in: path
 *         name: engagementId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - customerid
 *               - vacation_start_date
 *               - vacation_end_date
 *             properties:
 *               customerid: { type: integer }
 *               vacation_start_date: { type: string, format: date }
 *               vacation_end_date: { type: string, format: date }
 *               leave_type: { type: string, example: VACATION }
 *               modified_by_id: { type: integer }
 *               modified_by_role: { type: string, example: CUSTOMER }
 *     responses:
 *       "200":
 *         description: Vacation applied; wallet credit in response
 *       "400":
 *         description: Validation error
 *       "403":
 *         description: Engagement does not belong to customer
 *       "409":
 *         description: Restore/conflict with another booking
 *       "500":
 *         description: Server error
 */
