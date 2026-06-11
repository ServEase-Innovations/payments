import express from "express";
import pool from "../../config/db.js";
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret } from "../../utils/razorpayConfig.js";
import { createServiceDays } from "../serviceDays.service.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { transitionEngagement } from "../../services/engagementLifecycle.js";
import { activeEngagementStatusSql } from "../../services/providerAvailabilityOverlap.js";
import { applyVacationForEngagement } from "../../services/vacationApply.service.js";
import { createHmac } from "crypto";
import { resolvePricingForEngagement } from "../../services/pricing/engagementPricing.js";
import { buildResumeCheckoutResponse } from "../../utils/responseRedaction.js";
import {
  assertOnDemandProvidersAvailable,
  ON_DEMAND_PROVIDER_RADIUS_KM,
} from "../../services/onDemandProviderAvailability.js";
import {
  computeWalletApplication,
  deductWalletForPayment,
  getCustomerWalletBalance,
} from "../../services/customerWallet.service.js";
import {
  handlePaymentSuccess,
  runPostPaymentSuccessEffects,
} from "../../services/paymentLifecycle.service.js";

/**
 * V2 SP-backed engagement → calendar booking
 *
 * 1. **POST** `/api/v2/createEngagements` creates an `engagements` row (MONTHLY/SHORT_TERM with `serviceproviderid`) in **PAYMENT_PENDING**
 *    plus a PENDING payment and Razorpay order.
 * 2. **Payment success** (`POST /verify` or `/webhook` → `handlePaymentSuccess`) marks payment SUCCESS and calls
 *    **`transitionEngagement`** to **ASSIGNED** (non–ON_DEMAND). Assigned providers get in-app + socket there, not at create.
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

/** One visit cannot exceed 24h; prevents bad payloads (e.g. minutes ≈ contract length) from breaking overlap logic. */
const MAX_SERVICE_DURATION_MINUTES = 24 * 60;

function toEpochSeconds(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dt = dayjs.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
  if (!dt.isValid()) return null;
  return dt.unix();
}

function toFiniteEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function dateYmdFromEpoch(epochSeconds) {
  const epoch = toFiniteEpoch(epochSeconds);
  if (epoch == null) return null;
  return dayjs.unix(epoch).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

function normalizeYmdInput(dateLike) {
  if (!dateLike) return null;
  if (typeof dateLike === "string") {
    const trimmed = dateLike.trim();
    const strict = dayjs.tz(trimmed.slice(0, 10), "YYYY-MM-DD", "Asia/Kolkata");
    if (strict.isValid()) return strict.format("YYYY-MM-DD");
    const parsed = dayjs.tz(trimmed, "Asia/Kolkata");
    if (parsed.isValid()) return parsed.format("YYYY-MM-DD");
    return null;
  }
  const parsed = dayjs(dateLike).tz("Asia/Kolkata");
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
}

function ymdFromEpoch(epochSeconds) {
  const epoch = toFiniteEpoch(epochSeconds);
  if (epoch == null) return null;
  return dayjs.unix(epoch).tz("Asia/Kolkata").format("YYYY-MM-DD");
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

/**
 * Pre-checkout: are any on-demand providers available near the booking location?
 * GET /api/v2/createEngagements/on-demand-availability
 */
router.get("/on-demand-availability", async (req, res) => {
  try {
    const {
      latitude,
      longitude,
      lat,
      lng,
      service_type,
      start_date,
      start_time,
      start_epoch,
      end_epoch,
      duration_minutes,
    } = req.query;

    const resolvedLat = latitude ?? lat;
    const resolvedLng = longitude ?? lng;
    const resolvedStartEpoch =
      toFiniteEpoch(start_epoch) ??
      toEpochSeconds(
        normalizeYmdInput(start_date),
        String(start_time || "").trim() || null
      );

    if (!service_type) {
      return res.status(400).json({
        success: false,
        error: "service_type is required",
      });
    }
    if (!resolvedStartEpoch) {
      return res.status(400).json({
        success: false,
        error: "start_date and start_time (or start_epoch) are required",
      });
    }

    const rawDur =
      duration_minutes != null && Number.isFinite(Number(duration_minutes))
        ? Number(duration_minutes)
        : 60;
    const durationMinutes = Math.min(
      Math.max(rawDur, 15),
      MAX_SERVICE_DURATION_MINUTES
    );
    const startEp = resolvedStartEpoch;
    const endEp =
      toFiniteEpoch(end_epoch) ?? startEp + durationMinutes * 60;

    const availability = await assertOnDemandProvidersAvailable({
      latitude: resolvedLat,
      longitude: resolvedLng,
      serviceType: service_type,
      visitDateYmd: normalizeYmdInput(start_date) ?? ymdFromEpoch(startEp),
      startEpoch: startEp,
      endEpoch: endEp,
    });

    return res.json({
      success: true,
      available: availability.available,
      count: availability.count ?? 0,
      broadcastEligibleCount: availability.broadcastEligibleCount ?? availability.count ?? 0,
      strictCount: availability.strictCount ?? availability.count ?? 0,
      radiusKm: availability.radiusKm ?? ON_DEMAND_PROVIDER_RADIUS_KM,
      role: availability.role,
      code: availability.code,
      message: availability.available ? undefined : availability.message,
    });
  } catch (err) {
    console.error("on-demand-availability error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
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
      start_epoch,
      end_epoch,
      start_date_epoch,
      end_date_epoch,
      responsibilities,
      booking_type,
      service_type,
      base_amount,
      address,
      latitude,
      longitude,
      payment_mode = "razorpay",
      duration_minutes,
      use_wallet,
      useWallet,
    } = req.body;

    const useWalletBalance = Boolean(use_wallet ?? useWallet);

    const isOnDemand = booking_type === "ON_DEMAND";
    const resolvedStartEpoch =
      toFiniteEpoch(start_epoch) ??
      toEpochSeconds(
        normalizeYmdInput(start_date) ?? dateYmdFromEpoch(start_date_epoch),
        start_time
      );
    const resolvedStartDate =
      normalizeYmdInput(start_date) ??
      dateYmdFromEpoch(resolvedStartEpoch) ??
      dateYmdFromEpoch(start_date_epoch);
    const resolvedStartTime = start_time || (resolvedStartEpoch != null
      ? dayjs.unix(resolvedStartEpoch).tz("Asia/Kolkata").format("HH:mm")
      : null);
    const resolvedEndEpoch = toFiniteEpoch(end_epoch);
    const resolvedEndDate =
      normalizeYmdInput(end_date) ??
      dateYmdFromEpoch(resolvedEndEpoch) ??
      dateYmdFromEpoch(end_date_epoch) ??
      resolvedStartDate;

    if (
      !customerid ||
      !resolvedStartDate ||
      !resolvedStartTime ||
      !base_amount ||
      !booking_type ||
      !service_type
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

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
        resolvedStartDate,
        resolvedStartTime,
        end_time
      );
      if (fromClock != null) {
        durationMinutes = fromClock;
      }
    }
    const durationSec = durationMinutes * 60;

    const startEpoch = resolvedStartEpoch;
    if (!startEpoch) throw new Error("Invalid start time");

    const endEpoch = resolvedEndEpoch ?? (startEpoch + durationSec);

    const effectiveEndDate = isOnDemand ? resolvedStartDate : resolvedEndDate;
    if (!effectiveEndDate) {
      return res.status(400).json({ error: "Missing end_date for non ON_DEMAND booking" });
    }

    const custPreview = await pool.query(
      `SELECT customerid FROM customer WHERE customerid=$1`,
      [customerid]
    );
    if (!custPreview.rows.length) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (isOnDemand) {
      const availability = await assertOnDemandProvidersAvailable({
        latitude,
        longitude,
        serviceType: service_type,
        visitDateYmd: resolvedStartDate,
        startEpoch,
        endEpoch,
      });
      if (!availability.available) {
        return res.status(409).json({
          error: availability.message,
          code: availability.code,
          availableProviders: availability.count ?? 0,
          broadcastEligibleCount: availability.broadcastEligibleCount ?? 0,
          strictCount: availability.strictCount ?? 0,
        });
      }
    }

    await client.query("BEGIN");

    let responsibilitiesPayload = responsibilities;
    try {
      const priced = await resolvePricingForEngagement(req.body, client);
      if (priced) responsibilitiesPayload = priced.responsibilities;
    } catch (pricingErr) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: pricingErr.message });
    }

    // Overlap check: clip existing slots to this calendar day (IST). Rows sometimes store
    // multi-day spans from bad duration_minutes; raw epoch overlap then falsely blocks bookings.
    if (!isOnDemand && serviceproviderid) {
      const startD = new Date(resolvedStartDate);
      const endD = new Date(effectiveEndDate);
      for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
        const day = d.toISOString().slice(0, 10);
        const dayWindowStart = toEpochSeconds(day, "00:00");
        if (dayWindowStart == null) continue;
        const dayWindowEnd = dayWindowStart + 86400;
        const dayStartEpoch = toEpochSeconds(day, resolvedStartTime);
        if (dayStartEpoch == null) continue;
        const dayEndEpoch = dayStartEpoch + durationSec;
        const overlap = await client.query(
          `SELECT 1 FROM provider_availability pa
           INNER JOIN engagements e ON e.engagement_id = pa.engagement_id
           WHERE pa.serviceproviderid = $1
             AND pa.status = 'BOOKED'
             AND pa.date = $2::date
             AND pa.slot_start_epoch IS NOT NULL
             AND pa.slot_end_epoch IS NOT NULL
             AND ${activeEngagementStatusSql("e")}
             AND GREATEST(pa.slot_start_epoch, $5::bigint) < LEAST(pa.slot_end_epoch, $6::bigint)
             AND $3::bigint < LEAST(pa.slot_end_epoch, $6::bigint)
             AND $4::bigint > GREATEST(pa.slot_start_epoch, $5::bigint)
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
            detail: `Service provider ${serviceproviderid} is booked on ${day} at the selected time slot (${resolvedStartTime}).`,
          });
        }
      }
    }

    // Validate customer
    const cust = await client.query(
      `SELECT customerid FROM customer WHERE customerid=$1`,
      [customerid]
    );
    if (!cust.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Customer not found" });
    }

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
        resolvedStartDate,
        effectiveEndDate,
        responsibilitiesPayload,
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
    const platform_fee = Math.round(base_amount * 0.06 * 100) / 100;
    const gst = Math.round(platform_fee * 0.18 * 100) / 100;
    const total_amount = Math.round((base_amount + platform_fee + gst) * 100) / 100;

    const walletBalance = await getCustomerWalletBalance(client, customerid);
    const { wallet_amount, razorpay_amount } = computeWalletApplication(
      walletBalance,
      total_amount,
      useWalletBalance
    );

    let razorpay_order_id = null;
    let wallet_only = false;

    if (razorpay_amount > 0) {
      const razorpayOrder = await razorpay.orders.create({
        amount: Math.round(razorpay_amount * 100),
        currency: "INR",
        receipt: `eng_${engagement.engagement_id}`,
      });
      razorpay_order_id = razorpayOrder.id;
    } else {
      wallet_only = true;
      razorpay_order_id = `wallet_${engagement.engagement_id}_${Date.now()}`;
    }

    const effectivePaymentMode =
      wallet_only && wallet_amount > 0
        ? "wallet"
        : wallet_amount > 0
          ? "wallet+razorpay"
          : payment_mode;

    await client.query(
      `
      INSERT INTO payments
      (engagement_id, base_amount, platform_fee, gst, total_amount, wallet_amount,
       payment_mode, status, razorpay_order_id, wallet_deducted, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,NOW())
      `,
      [
        engagement.engagement_id,
        base_amount,
        platform_fee,
        gst,
        total_amount,
        wallet_amount,
        effectivePaymentMode,
        razorpay_order_id,
        false,
      ]
    );

    if (wallet_only) {
      if (wallet_amount <= 0) {
        throw new Error("Wallet balance is insufficient for this booking");
      }

      await deductWalletForPayment(client, {
        customerId: customerid,
        engagementId: engagement.engagement_id,
        amount: wallet_amount,
      });

      await client.query(
        `
        UPDATE payments
        SET status = 'SUCCESS',
            wallet_deducted = true,
            transaction_id = $1,
            updated_at = NOW()
        WHERE engagement_id = $2
        `,
        [razorpay_order_id, engagement.engagement_id]
      );

      const nextStatus =
        engagement.booking_type === "ON_DEMAND"
          ? "OPEN_FOR_ACCEPTANCE"
          : "ASSIGNED";

      await transitionEngagement(client, {
        engagementId: engagement.engagement_id,
        newStatus: nextStatus,
        eventType: "PAYMENT_COMPLETED",
        actorType: "SYSTEM",
        metadata: {
          source: "WALLET_ONLY",
          wallet_amount,
        },
      });
    }

    await client.query("COMMIT");

    if (wallet_only) {
      try {
        await runPostPaymentSuccessEffects(engagement.engagement_id, req.io);
      } catch (notifyErr) {
        console.error("post wallet-only payment notify failed", notifyErr);
      }
    }

    return res.status(201).json({
      success: true,
      engagement_id: engagement.engagement_id,
      razorpay_order_id,
      razorpay_key_id: wallet_only ? null : getRazorpayKeyId(),
      total_amount,
      wallet_amount,
      razorpay_amount,
      wallet_only,
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
 * Resume Razorpay checkout for an engagement with PENDING payment (My Bookings → Pay now).
 * POST /api/v2/createEngagements/resume-payment
 * Body: { engagementId: number }
 */
router.post("/resume-payment", async (req, res) => {
  try {
    const engagementId = Number(
      req.body?.engagementId ?? req.body?.engagement_id
    );

    if (!Number.isFinite(engagementId) || engagementId < 1) {
      return res.status(400).json({
        success: false,
        error: "engagementId is required",
      });
    }

    const result = await pool.query(
      `
      SELECT
        p.payment_id,
        p.razorpay_order_id,
        p.total_amount,
        p.wallet_amount,
        p.status AS payment_status,
        e.engagement_id,
        e.customerid,
        e.booking_type,
        e.service_type,
        e.engagement_status,
        e.latitude,
        e.longitude,
        e.start_date,
        e.start_epoch,
        e.end_epoch,
        e.duration_minutes,
        c.firstname,
        c.lastname,
        c.mobileno,
        c.emailid
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
        error: "Payment not found for this booking",
      });
    }

    const row = result.rows[0];

    if (row.payment_status === "SUCCESS") {
      return res.status(400).json({
        success: false,
        error: "Payment already completed",
      });
    }

    const totalInr = Number(row.total_amount);
    if (!Number.isFinite(totalInr) || totalInr <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment amount on record",
      });
    }

    if (String(row.booking_type || "").toUpperCase() === "ON_DEMAND") {
      const startEp = Number(row.start_epoch);
      const durMin = Number(row.duration_minutes);
      const endEp =
        Number(row.end_epoch) > startEp
          ? Number(row.end_epoch)
          : startEp + (Number.isFinite(durMin) ? durMin : 60) * 60;
      const availability = await assertOnDemandProvidersAvailable({
        latitude: row.latitude,
        longitude: row.longitude,
        serviceType: row.service_type,
        visitDateYmd: row.start_date,
        startEpoch: startEp,
        endEpoch: endEp,
      });
      if (!availability.available) {
        return res.status(409).json({
          success: false,
          error: availability.message,
          code: availability.code,
          availableProviders: availability.count ?? 0,
        });
      }
    }

    const walletInr = Math.max(0, Number(row.wallet_amount ?? 0));
    const razorpayInr = Math.round((totalInr - walletInr) * 100) / 100;

    if (!Number.isFinite(razorpayInr) || razorpayInr <= 0) {
      return res.status(400).json({
        success: false,
        error:
          walletInr > 0
            ? "This booking is payable from wallet only. Use checkout with wallet enabled."
            : "Invalid payment amount on record",
      });
    }

    const amountPaise = Math.round(razorpayInr * 100);

    // Fresh order on each resume so amount always matches DB and Checkout key matches server account.
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `eng_resume_${engagementId}_${Date.now()}`,
      notes: { engagementId: String(engagementId) },
    });
    const razorpay_order_id = razorpayOrder.id;
    await pool.query(
      `
      UPDATE payments
      SET razorpay_order_id = $1, updated_at = NOW()
      WHERE engagement_id = $2
      `,
      [razorpay_order_id, engagementId]
    );

    return res.json(
      buildResumeCheckoutResponse({
        razorpay_order_id,
        razorpay_key_id: getRazorpayKeyId(),
        amount: amountPaise,
        amount_inr: razorpayInr,
        total_amount_inr: totalInr,
        wallet_amount_inr: walletInr,
        currency: "INR",
        engagement_id: engagementId,
        booking_type: row.booking_type,
        service_type: row.service_type,
        status: row.engagement_status,
        created_at: row.created_at,
        customer: {
          customerid: row.customerid,
          firstname: row.firstname,
          lastname: row.lastname,
          contact: row.mobileno,
          email: row.emailid,
        },
      })
    );
  } catch (err) {
    console.error("V2 resume-payment error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
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
      vacation_start_epoch,
      vacation_end_epoch,
      leave_type,
      modified_by_id,
      modified_by_role,
    } = req.body || {};

    const resolvedVacationStartDate =
      normalizeYmdInput(vacation_start_date) ?? ymdFromEpoch(vacation_start_epoch);
    const resolvedVacationEndDate =
      normalizeYmdInput(vacation_end_date) ?? ymdFromEpoch(vacation_end_epoch);

    if (!Number.isFinite(engagementId) || engagementId < 1) {
      return res.status(400).json({ success: false, error: "Invalid engagementId" });
    }
    if (!customerid || !resolvedVacationStartDate || !resolvedVacationEndDate) {
      return res.status(400).json({
        success: false,
        error: "customerid, vacation_start_date, and vacation_end_date are required",
      });
    }

    await client.query("BEGIN");

    const result = await applyVacationForEngagement(client, {
      engagementId,
      customerId: customerid,
      vacationStartDate: resolvedVacationStartDate,
      vacationEndDate: resolvedVacationEndDate,
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

import { handleRazorpayPaymentWebhook } from "../../services/razorpayWebhook.service.js";

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
  getRazorpayKeySecret()
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

router.post("/webhook", handleRazorpayPaymentWebhook);




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
 *       Verifies x-razorpay-signature using RAZORPAY_WEBHOOK_SECRET (required in production).
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
