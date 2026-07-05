import express from "express";
import pool from "../../config/db.js";
import { transitionEngagement } from "../../services/engagementLifecycle.js";
import Razorpay from "razorpay";
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret } from "../../utils/razorpayConfig.js";
import { createHmac } from "crypto";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import geolib from "geolib";
import { createServiceDays } from "../serviceDays.service.js";
import {
  createInAppNotification,
  InAppTypes,
  dismissNewBookingInAppByEngagementId,
  emitBookingRequestClosed,
} from "../../services/inAppNotification.service.js";
import { findProviderBookedConflict } from "../../services/providerAvailabilityOverlap.js";
import {
  assertCancellationAllowed,
  loadCancellationPolicy,
} from "../../services/cancellationPolicy.js";
import { refundPaidBookingToCustomer } from "../../services/bookingPaymentRefund.service.js";
import { redactEngagementForProvider } from "../../utils/responseRedaction.js";
import {
  acceptOnDemandIntoQueue,
  adminSetProviderQueue,
  countActiveQueue,
  declineOnDemandOffer,
  fetchActiveQueueRows,
  postAcceptNotifications,
  withdrawFromOnDemandQueue,
} from "../../services/onDemandProviderQueue.service.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

function epochToTimeHM(epochSeconds) {
  if (!epochSeconds) return null;
  return dayjs.unix(Number(epochSeconds)).tz("Asia/Kolkata").format("HH:mm");
}

const router = express.Router();


router.post("/:id/assign", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { providerId, providerIds } = req.body;
    const ordered =
      Array.isArray(providerIds) && providerIds.length
        ? providerIds
        : providerId != null
          ? [providerId]
          : [];

    if (!ordered.length) {
      return res.status(400).json({ error: "providerId or providerIds required" });
    }

    await client.query("BEGIN");

    const engRes = await client.query(
      `SELECT booking_type FROM engagements WHERE engagement_id=$1`,
      [id]
    );
    if (!engRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }

    if (String(engRes.rows[0].booking_type || "").toUpperCase() === "ON_DEMAND") {
      const result = await adminSetProviderQueue(client, id, ordered, {
        adminUserId: req.user?.id || null,
      });
      await client.query("COMMIT");
      return res.json({ success: true, engagement: result.engagement, provider_queue: result.provider_queue });
    }

    await client.query(
      `UPDATE engagements
       SET serviceproviderid=$1,
           assignment_status='ASSIGNED'
       WHERE engagement_id=$2`,
      [ordered[0], id]
    );

    await transitionEngagement(client, {
      engagementId: id,
      newStatus: "ASSIGNED",
      eventType: "PROVIDER_ASSIGNED",
      actorType: "ADMIN",
      actorId: req.user?.id || null,
      metadata: { providerId: ordered[0] },
    });

    await client.query("COMMIT");

    res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


router.post("/:id/start", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query("BEGIN");

    await transitionEngagement(client, {
      engagementId: id,
      newStatus: "IN_PROGRESS",
      eventType: "SERVICE_STARTED",
      actorType: "PROVIDER",
      actorId: req.user?.id
    });

    await client.query("COMMIT");

    res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


router.post("/:id/complete", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query("BEGIN");

    await transitionEngagement(client, {
      engagementId: id,
      newStatus: "COMPLETED",
      eventType: "SERVICE_COMPLETED",
      actorType: "PROVIDER",
      actorId: req.user?.id
    });

    await client.query("COMMIT");

    res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


router.post("/:id/cancel", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { reason } = req.body;

    const engagementRes = await client.query(
      `SELECT e.*, e.customerid, e.booking_type, e.start_epoch, e.start_date, 
              e.engagement_status, e.task_status
       FROM engagements e
       WHERE e.engagement_id = $1`,
      [id]
    );

    if (!engagementRes.rows.length) {
      return res.status(404).json({ error: "Engagement not found" });
    }

    const engagement = engagementRes.rows[0];
    const status = String(engagement.engagement_status || "").toUpperCase();
    const task = String(engagement.task_status || "").toUpperCase();
    
    if (status === "CANCELLED") {
      return res.status(400).json({ error: "Engagement is already cancelled" });
    }
    if (status === "IN_PROGRESS" || task === "IN_PROGRESS" || task === "STARTED") {
      return res.status(400).json({ error: "Cannot cancel after service has started" });
    }

    const policy = await loadCancellationPolicy();
    try {
      assertCancellationAllowed(engagement, policy);
    } catch (policyErr) {
      const statusCode = policyErr.statusCode || 400;
      return res.status(statusCode).json({ error: policyErr.message });
    }

    await client.query("BEGIN");

    // Fetch payment details for refund processing
    const paymentRes = await client.query(
      `SELECT payment_id, engagement_id, total_amount, wallet_amount, 
              wallet_deducted, transaction_id, status, payment_mode
       FROM payments
       WHERE engagement_id = $1
       ORDER BY payment_id DESC
       LIMIT 1`,
      [id]
    );

    let refundResult = null;
    let refundDescription = null;

    // Process refund if payment exists and was successful
    if (paymentRes.rows.length > 0) {
      const payment = paymentRes.rows[0];
      const paymentStatus = String(payment.status || "").toUpperCase();

      if (paymentStatus === "SUCCESS") {
        console.log(`[cancel-engagement] Processing refund for engagement ${id}`);
        
        refundDescription = `Refund for cancelled booking #${id}`;
        
        try {
          refundResult = await refundPaidBookingToCustomer(client, {
            payment,
            customerId: Number(engagement.customerid),
            engagementId: id,
            refundDescription,
            razorpayNotes: {
              reason: reason || "User cancelled booking",
              cancelled_by: "CUSTOMER",
            },
          });

          console.log(`[cancel-engagement] Refund processed for engagement ${id}:`, {
            walletRefund: refundResult.walletRefund,
            razorpayRefund: refundResult.razorpayRefund,
            walletBalanceAfter: refundResult.walletBalanceAfter,
          });

          // Update payment status to REFUNDED
          await client.query(
            `UPDATE payments
             SET status = 'REFUNDED',
                 updated_at = NOW()
             WHERE payment_id = $1`,
            [payment.payment_id]
          );

        } catch (refundErr) {
          console.error(`[cancel-engagement] Refund failed for engagement ${id}:`, refundErr);
          await client.query("ROLLBACK");
          return res.status(500).json({ 
            error: "Failed to process refund", 
            details: refundErr.message 
          });
        }
      } else {
        console.log(`[cancel-engagement] No refund needed for engagement ${id}, payment status: ${paymentStatus}`);
      }
    } else {
      console.log(`[cancel-engagement] No payment found for engagement ${id}`);
    }

    // Transition engagement to CANCELLED status
    await transitionEngagement(client, {
      engagementId: id,
      newStatus: "CANCELLED",
      eventType: "ENGAGEMENT_CANCELLED",
      actorType: "CUSTOMER",
      actorId: req.user?.id,
      metadata: {
        reason: reason || "User cancelled booking",
        refund_amount_inr: refundResult ? refundResult.total : null,
        wallet_refund_amount_inr: refundResult ? refundResult.walletRefund : null,
        razorpay_refund_amount_inr: refundResult ? refundResult.razorpayRefund : null,
        razorpay_payment_id: refundResult ? refundResult.razorpayPaymentId : null,
        razorpay_refund_id: refundResult ? refundResult.razorpayRefundId : null,
        wallet_balance_after: refundResult ? refundResult.walletBalanceAfter : null,
      }
    });

    await client.query("COMMIT");

    res.json({ 
      success: true,
      refund: refundResult ? {
        total: refundResult.total,
        walletRefund: refundResult.walletRefund,
        razorpayRefund: refundResult.razorpayRefund,
        walletBalanceAfter: refundResult.walletBalanceAfter,
        message: refundResult.razorpayRefund > 0 
          ? `₹${refundResult.walletRefund.toFixed(2)} credited to wallet. ₹${refundResult.razorpayRefund.toFixed(2)} will be refunded to your payment method in 5-7 business days.`
          : `₹${refundResult.walletRefund.toFixed(2)} credited to your wallet.`
      } : null
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[cancel-engagement] Error cancelling engagement ${req.params.id}:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== EXTEND SERVICE HOUR ENDPOINTS ====================

/**
 * Check if booking can be extended and get available extension options
 * GET /api/v2/engagements/:id/extension-availability
 */
router.get("/:id/extension-availability", async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    
    // Get engagement details with payment total and timeline data
    const engRes = await client.query(
      `SELECT e.engagement_id, e.booking_type, e.serviceproviderid, e.service_type,
              e.end_epoch, e.engagement_status, e.task_status,
              e.start_epoch, e.base_amount, e.duration_minutes,
              e.actual_start_epoch, e.actual_end_epoch, e.is_timeline_recalculated,
              p.total_amount
       FROM engagements e
       LEFT JOIN payments p ON p.engagement_id = e.engagement_id AND p.status = 'SUCCESS'
       WHERE e.engagement_id = $1
       ORDER BY p.created_at DESC
       LIMIT 1`,
      [id]
    );
    
    if (!engRes.rows.length) {
      return res.status(404).json({ error: "Engagement not found" });
    }
    
    const engagement = engRes.rows[0];
    const bookingType = String(engagement.booking_type || "").toUpperCase();
    const taskStatus = String(engagement.task_status || "").toUpperCase();
    const engagementStatus = String(engagement.engagement_status || "").toUpperCase();
    
    // Validation: Only ON_DEMAND bookings can be extended
    if (bookingType !== "ON_DEMAND") {
      return res.json({
        success: true,
        canExtend: false,
        reason: "Only one-time bookings can be extended",
        maxExtensionHours: 0,
        availableSlots: []
      });
    }
    
    // Validation: Must have assigned provider
    if (!engagement.serviceproviderid) {
      return res.json({
        success: true,
        canExtend: false,
        reason: "No provider assigned",
        maxExtensionHours: 0,
        availableSlots: []
      });
    }
    
    // Validation: Only active bookings can be extended
    if (!["NOT_STARTED", "IN_PROGRESS"].includes(taskStatus)) {
      return res.json({
        success: true,
        canExtend: false,
        reason: "Booking is not active",
        maxExtensionHours: 0,
        availableSlots: []
      });
    }
    
    // Validation: For completed bookings, cannot extend
    // For NOT_STARTED and IN_PROGRESS, we can extend
    // Note: We don't check if booking has ended by time, only by status
    // This allows extending bookings that are scheduled for the future
    
    // Check provider conflicts after current end time
    // Use recalculated end time if available, otherwise use scheduled end time
    const currentEndEpoch = Number(engagement.actual_end_epoch || engagement.end_epoch);
    const calculationBase = engagement.actual_end_epoch ? 'recalculated_timeline' : 'scheduled_timeline';
    
    console.log('[extension-availability] Timeline info:', {
      scheduled_end: engagement.end_epoch,
      actual_end: engagement.actual_end_epoch,
      using_end: currentEndEpoch,
      calculation_base: calculationBase,
      is_recalculated: engagement.is_timeline_recalculated
    });
    
    const maxCheckHours = 4; // Check up to 4 hours ahead
    
    // Platform constraint: Services must end by 8:00 PM (20:00)
    const WORK_DAY_END_HOUR = 20;
    const currentEndTime = dayjs.unix(currentEndEpoch).tz("Asia/Kolkata");
    
    // Work day end is on the same calendar day as the booking end time
    const workDayEnd = currentEndTime.clone()
      .hour(WORK_DAY_END_HOUR)
      .minute(0)
      .second(0)
      .millisecond(0);
    
    // Calculate max hours from booking end to work day end (8 PM)
    const secondsUntilWorkDayEnd = workDayEnd.unix() - currentEndEpoch;
    const maxHoursUntilWorkDayEnd = Math.floor(secondsUntilWorkDayEnd / 3600);
    
    console.log('[extension-availability] Debug:', {
      currentEndEpoch,
      currentEndTime: currentEndTime.format('YYYY-MM-DD HH:mm:ss'),
      workDayEnd: workDayEnd.format('YYYY-MM-DD HH:mm:ss'),
      workDayEndEpoch: workDayEnd.unix(),
      secondsUntilWorkDayEnd,
      maxHoursUntilWorkDayEnd,
      serviceproviderid: engagement.serviceproviderid
    });
    
    // Limit to the lesser of: max check hours OR hours until work day ends
    let maxExtensionHours = Math.min(maxCheckHours, Math.max(0, maxHoursUntilWorkDayEnd));
    
    // If already at or past 8 PM, cannot extend
    if (maxHoursUntilWorkDayEnd <= 0) {
      return res.json({
        success: true,
        canExtend: false,
        reason: "Service must end by 8:00 PM. Cannot extend further.",
        maxExtensionHours: 0,
        availableSlots: []
      });
    }
    
    const maxCheckEpoch = currentEndEpoch + (maxExtensionHours * 3600);
    
    console.log('[extension-availability] Conflict check:', {
      currentEndEpoch,
      maxCheckEpoch,
      maxExtensionHours,
      range: `${currentEndEpoch} to ${maxCheckEpoch}`
    });
    
    // For conflict detection, we need to be smart about booking types:
    // - ON_DEMAND bookings are specific time slots (e.g., 10 AM - 4 PM on July 2)
    // - SHORT_TERM/MONTHLY bookings span multiple days but have specific daily time slots
    // We should only check for conflicts with other ON_DEMAND bookings in the same time window
    // OR check if SHORT_TERM bookings have overlapping daily time slots
    
    const conflictRes = await client.query(
      `SELECT e.engagement_id, e.start_epoch, e.end_epoch, e.task_status, e.booking_type
       FROM engagements e
       WHERE e.serviceproviderid = $1
         AND e.engagement_id != $2
         AND e.task_status NOT IN ('CANCELLED', 'COMPLETED')
         AND e.booking_type = 'ON_DEMAND'
         AND (
           (e.start_epoch >= $3 AND e.start_epoch < $4) OR
           (e.end_epoch > $3 AND e.end_epoch <= $4) OR
           (e.start_epoch <= $3 AND e.end_epoch >= $4)
         )
       ORDER BY e.start_epoch
       LIMIT 1`,
      [engagement.serviceproviderid, id, currentEndEpoch, maxCheckEpoch]
    );
    
    console.log('[extension-availability] ON_DEMAND conflicts found:', conflictRes.rows.length, conflictRes.rows);
    
    // If there's a conflict, further limit max hours to avoid the conflict
    if (conflictRes.rows.length > 0) {
      const nextBooking = conflictRes.rows[0];
      const hoursUntilConflict = Math.floor((Number(nextBooking.start_epoch) - currentEndEpoch) / 3600);
      maxExtensionHours = Math.min(maxExtensionHours, hoursUntilConflict);
    }
    
    // For on-demand bookings, use standard hourly rate (₹175 mid-point)
    // This matches the onDemandPricing.js module: ₹150-₹200/hr (mid = ₹175)
    const HOURLY_RATE = 175;
    const INCREMENTAL_HOUR_DISCOUNT_PCT = 5; // 5% off for 2nd, 3rd, 4th hours...
    
    const durationMinutes = Number(engagement.duration_minutes) || 60;
    const durationHours = durationMinutes / 60;
    const baseAmount = Number(engagement.base_amount) || 0;
    
    // Get or calculate current total amount (with fees)
    let currentTotalAmount = Number(engagement.total_amount) || 0;
    if (currentTotalAmount === 0 && baseAmount > 0) {
      // Calculate total from base if not available
      const currentPlatformFee = Math.round(baseAmount * 0.06 * 100) / 100;
      const currentGst = Math.round(currentPlatformFee * 0.18 * 100) / 100;
      currentTotalAmount = Math.round((baseAmount + currentPlatformFee + currentGst) * 100) / 100;
    }
    
    // Generate available slots with proper pricing (base + platform fee + GST + discounts)
    const availableSlots = [];
    for (let hours = 1; hours <= maxExtensionHours; hours++) {
      const newEndEpoch = currentEndEpoch + (hours * 3600);
      const newEndTime = dayjs.unix(newEndEpoch).tz("Asia/Kolkata");
      
      // Calculate additional base amount with incremental discount
      // 1st extension hour: full rate
      // 2nd+ extension hours: 5% off each
      let additionalBaseGross = 0;
      let additionalBaseNet = 0;
      let hourDiscount = 0;
      
      for (let h = 1; h <= hours; h++) {
        const hourRate = HOURLY_RATE;
        additionalBaseGross += hourRate;
        
        if (h === 1) {
          // First extension hour at full rate
          additionalBaseNet += hourRate;
        } else {
          // Additional hours get 5% discount
          const discountedRate = Math.round(hourRate * (1 - INCREMENTAL_HOUR_DISCOUNT_PCT / 100) * 100) / 100;
          additionalBaseNet += discountedRate;
          hourDiscount += Math.round((hourRate - discountedRate) * 100) / 100;
        }
      }
      
      additionalBaseGross = Math.round(additionalBaseGross * 100) / 100;
      additionalBaseNet = Math.round(additionalBaseNet * 100) / 100;
      hourDiscount = Math.round(hourDiscount * 100) / 100;
      
      // Calculate platform fee (6%) on net base amount (after hour discount)
      const platformFee = Math.round(additionalBaseNet * 0.06 * 100) / 100;
      const gst = Math.round(platformFee * 0.18 * 100) / 100;
      const additionalTotal = Math.round((additionalBaseNet + platformFee + gst) * 100) / 100;
      
      // Calculate new total booking cost
      const newTotal = Math.round((currentTotalAmount + additionalTotal) * 100) / 100;
      
      availableSlots.push({
        hours,
        newEndTime: newEndTime.toISOString(),
        newEndTimeFormatted: newEndTime.format("DD MMM YYYY, hh:mm A"),
        pricing: {
          baseGross: additionalBaseGross,
          baseNet: additionalBaseNet,
          hourDiscount: hourDiscount,
          platformFee: platformFee,
          gst: gst,
          total: additionalTotal
        },
        // Legacy fields for backward compatibility
        additionalBase: additionalBaseNet,
        platformFee,
        gst,
        additionalCost: additionalTotal,
        totalCost: newTotal,
        // Discount details
        discounts: hourDiscount > 0 ? [{
          label: `${INCREMENTAL_HOUR_DISCOUNT_PCT}% off on ${hours - 1} additional hour${hours > 2 ? 's' : ''}`,
          amount: hourDiscount
        }] : []
      });
    }
    
    // Determine reason if cannot extend
    let reason = null;
    if (maxExtensionHours <= 0) {
      if (maxHoursUntilWorkDayEnd <= 0) {
        reason = "Service must end by 8:00 PM. Cannot extend further.";
      } else if (conflictRes.rows.length > 0) {
        reason = "Provider has conflicting bookings";
      } else {
        reason = "No extension slots available";
      }
    }
    
    res.json({
      success: true,
      canExtend: maxExtensionHours > 0,
      maxExtensionHours,
      providerAvailable: true,
      currentEndTime: dayjs.unix(currentEndEpoch).tz("Asia/Kolkata").toISOString(),
      currentEndTimeFormatted: dayjs.unix(currentEndEpoch).tz("Asia/Kolkata").format("DD MMM YYYY, hh:mm A"),
      hourlyBaseRate: HOURLY_RATE,
      bookingDetails: {
        baseAmount,
        totalAmount: currentTotalAmount,
        durationMinutes,
        durationHours
      },
      availableSlots,
      reason
    });
    
  } catch (err) {
    console.error("[extension-availability] Error:", err);
    res.status(500).json({ error: "Failed to check extension availability" });
  } finally {
    client.release();
  }
});

/**
 * Extend booking with additional hours - Razorpay payment flow
 * POST /api/v2/engagements/:id/extend
 * 
 * Step 1: Validate, check conflicts, create Razorpay order, and log EXTENSION_INITIATED event
 * Returns: { success: true, requires_payment: true, razorpay_order_id, razorpay_key_id, amount, currency, extensionDetails }
 */
router.post("/:id/extend", async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { extensionHours, newEndTime, additionalAmount } = req.body;
    
    // Validation
    if (!extensionHours || extensionHours < 1) {
      return res.status(400).json({ error: "Invalid extension hours" });
    }
    
    if (!newEndTime) {
      return res.status(400).json({ error: "New end time required" });
    }
    
    if (!additionalAmount || additionalAmount <= 0) {
      return res.status(400).json({ error: "Invalid additional amount" });
    }
    
    await client.query("BEGIN");
    
    // Get engagement with lock
    const engRes = await client.query(
      `SELECT e.* FROM engagements e
       WHERE e.engagement_id = $1
       FOR UPDATE`,
      [id]
    );
    
    if (!engRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }
    
    const engagement = engRes.rows[0];
    const bookingType = String(engagement.booking_type || "").toUpperCase();
    const taskStatus = String(engagement.task_status || "").toUpperCase();
    
    // Revalidate booking can be extended
    if (bookingType !== "ON_DEMAND") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Only one-time bookings can be extended" });
    }
    
    if (!["NOT_STARTED", "IN_PROGRESS"].includes(taskStatus)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Booking is not active" });
    }
    
    if (!engagement.serviceproviderid) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No provider assigned" });
    }
    
    // Check for conflicts (prevent race conditions)
    // Only check for conflicts with other ON_DEMAND bookings
    const newEndEpoch = dayjs(newEndTime).unix();
    const currentEndEpoch = Number(engagement.end_epoch);
    
    const conflictCheck = await client.query(
      `SELECT engagement_id FROM engagements
       WHERE serviceproviderid = $1
         AND engagement_id != $2
         AND booking_type = 'ON_DEMAND'
         AND task_status NOT IN ('CANCELLED', 'COMPLETED')
         AND start_epoch < $3
         AND end_epoch > $4`,
      [engagement.serviceproviderid, id, newEndEpoch, currentEndEpoch]
    );
    
    if (conflictCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ 
        error: "Provider has a conflicting booking in the extended time slot" 
      });
    }
    
    // Create Razorpay order
    const amountPaise = Math.round(additionalAmount * 100);
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `ext_${id}_${Date.now()}`,
    });
    
    // Calculate breakdown: additionalAmount = base + platform_fee + gst
    // Where platform_fee = base * 0.06 and gst = platform_fee * 0.18
    // So: total = base * (1 + 0.06 + 0.06*0.18) = base * 1.0708
    const extensionBase = Math.round((additionalAmount / 1.0708) * 100) / 100;
    const extensionPlatformFee = Math.round(extensionBase * 0.06 * 100) / 100;
    const extensionGst = Math.round(extensionPlatformFee * 0.18 * 100) / 100;
    
    // Create payment record with PENDING status
    await client.query(
      `INSERT INTO payments (
        engagement_id, total_amount, base_amount, platform_fee, gst,
        payment_mode, status, razorpay_order_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'RAZORPAY', 'PENDING', $6, NOW())`,
      [
        id,
        additionalAmount,
        extensionBase,
        extensionPlatformFee,
        extensionGst,
        razorpayOrder.id
      ]
    );
    
    // Log EXTENSION_INITIATED event with extension details in metadata
    await client.query(
      `INSERT INTO engagement_events (
        engagement_id, from_status, to_status, event_type,
        actor_type, actor_id, metadata, created_at
      ) VALUES ($1, $2, $3, 'EXTENSION_INITIATED', 'CUSTOMER', $4, $5, NOW())`,
      [
        id,
        taskStatus,
        taskStatus,
        engagement.customerid,
        JSON.stringify({
          extension_hours: extensionHours,
          additional_amount: additionalAmount,
          new_end_time: newEndTime,
          old_end_epoch: currentEndEpoch,
          new_end_epoch: newEndEpoch,
          razorpay_order_id: razorpayOrder.id
        })
      ]
    );
    
    await client.query("COMMIT");
    
    // Return Razorpay payment details (like booking creation)
    res.json({
      success: true,
      requires_payment: true,
      razorpay_order_id: razorpayOrder.id,
      razorpay_key_id: getRazorpayKeyId(),
      amount: amountPaise,
      currency: "INR",
      extensionDetails: {
        hours: extensionHours,
        additionalAmount,
        newEndTime,
        oldEndEpoch: currentEndEpoch,
        newEndEpoch
      }
    });
    
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[extend-booking] Error:", err);
    console.error("[extend-booking] Error details:", {
      message: err.message,
      stack: err.stack,
      code: err.code
    });
    res.status(500).json({ 
      error: "Failed to initiate extension payment",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release();
  }
});

/**
 * Verify Razorpay payment for booking extension
 * POST /api/v2/engagements/:id/extend/verify
 * 
 * Step 2: Verify signature, retrieve extension details from EXTENSION_INITIATED event,
 * update engagement, mark payment SUCCESS, log BOOKING_EXTENDED event, and notify provider
 */
router.post("/:id/extend/verify", async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    // Validation
    if (!razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({ 
        error: "razorpay_order_id and razorpay_payment_id are required" 
      });
    }
    
    // Verify Razorpay signature (same as /api/v2/createEngagements/verify)
    if (process.env.SKIP_RAZORPAY_VERIFY !== "true") {
      const body = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSignature = createHmac("sha256", getRazorpayKeySecret())
        .update(body)
        .digest("hex");
      
      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: "Invalid Razorpay signature" });
      }
    }
    
    await client.query("BEGIN");
    
    // Get engagement with lock
    const engRes = await client.query(
      `SELECT e.* FROM engagements e
       WHERE e.engagement_id = $1
       FOR UPDATE`,
      [id]
    );
    
    if (!engRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }
    
    const engagement = engRes.rows[0];
    
    // Retrieve EXTENSION_INITIATED event to get extension details
    const eventRes = await client.query(
      `SELECT metadata FROM engagement_events
       WHERE engagement_id = $1
         AND event_type = 'EXTENSION_INITIATED'
         AND metadata->>'razorpay_order_id' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [id, razorpay_order_id]
    );
    
    if (!eventRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        error: "Extension initiation record not found" 
      });
    }
    
    const extensionMetadata = eventRes.rows[0].metadata;
    const {
      extension_hours: extensionHours,
      additional_amount: additionalAmount,
      new_end_time: newEndTime,
      old_end_epoch: oldEndEpoch,
      new_end_epoch: newEndEpoch
    } = extensionMetadata;
    
    // Calculate base amount from total (reverse calculation)
    // total = base * 1.0708, so base = total / 1.0708
    const extensionBase = Math.round((additionalAmount / 1.0708) * 100) / 100;
    
    // Update engagement with new end time and base amount (not total)
    await client.query(
      `UPDATE engagements
       SET end_epoch = $1,
           base_amount = base_amount + $2
       WHERE engagement_id = $3`,
      [newEndEpoch, extensionBase, id]
    );
    
    // Update payment status to SUCCESS with razorpay_payment_id
    await client.query(
      `UPDATE payments
       SET status = 'SUCCESS',
           transaction_id = $1,
           updated_at = NOW()
       WHERE engagement_id = $2
         AND razorpay_order_id = $3
         AND status = 'PENDING'`,
      [razorpay_payment_id, id, razorpay_order_id]
    );
    
    const taskStatus = String(engagement.task_status || "").toUpperCase();
    
    // Log BOOKING_EXTENDED event
    await client.query(
      `INSERT INTO engagement_events (
        engagement_id, from_status, to_status, event_type,
        actor_type, actor_id, metadata, created_at
      ) VALUES ($1, $2, $3, 'BOOKING_EXTENDED', 'CUSTOMER', $4, $5, NOW())`,
      [
        id,
        taskStatus,
        taskStatus,
        engagement.customerid,
        JSON.stringify({
          extension_hours: extensionHours,
          additional_amount: additionalAmount,
          new_end_time: newEndTime,
          old_end_epoch: oldEndEpoch,
          new_end_epoch: newEndEpoch,
          razorpay_order_id,
          razorpay_payment_id
        })
      ]
    );
    
    // Send notification to provider
    if (engagement.serviceproviderid) {
      await createInAppNotification({
        recipientType: "provider",
        recipientId: engagement.serviceproviderid,
        type: InAppTypes.BOOKING_EXTENDED,
        title: "Booking Extended",
        body: `Customer extended booking #${id} by ${extensionHours} hour${extensionHours > 1 ? 's' : ''}`,
        engagementId: id,
        metadata: {
          extension_hours: extensionHours,
          new_end_time: newEndTime,
          additional_amount: additionalAmount
        }
      });
    }
    
    await client.query("COMMIT");
    
    // Get updated engagement
    const updatedRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id = $1`,
      [id]
    );
    
    res.json({
      success: true,
      message: `Booking extended by ${extensionHours} hour${extensionHours > 1 ? 's' : ''} successfully`,
      engagement: updatedRes.rows[0],
      extensionDetails: {
        hours: extensionHours,
        additionalAmount,
        newEndTime
      }
    });
    
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[extend-verify] Error:", err);
    res.status(500).json({ error: "Failed to verify extension payment" });
  } finally {
    client.release();
  }
});

router.get("/:id/history", async (req, res) => {
  const { id } = req.params;

  const events = await pool.query(`
    SELECT event_id,
           from_status,
           to_status,
           event_type,
           actor_type,
           actor_id,
           metadata,
           created_at
    FROM engagement_events
    WHERE engagement_id=$1
    ORDER BY created_at DESC
  `, [id]);

  res.json({
    success: true,
    history: events.rows
  });
});


/** ON_DEMAND: open for provider accept after customer payment (webhook or verify). */
const ON_DEMAND_ACCEPTABLE_ENGAGEMENT_STATUSES = new Set([
  "OPEN_FOR_ACCEPTANCE",
  "UNASSIGNED",
  "CRM_ESCALATED",
]);

/**
 * If verify/webhook failed to advance status but payment is SUCCESS, repair before accept.
 */
async function repairOnDemandEngagementIfPaid(client, engagement) {
  const bookingType = String(engagement.booking_type || "").toUpperCase();
  if (bookingType !== "ON_DEMAND") return engagement;

  const life = String(engagement.engagement_status || "").toUpperCase();
  if (ON_DEMAND_ACCEPTABLE_ENGAGEMENT_STATUSES.has(life)) return engagement;

  const payRes = await client.query(
    `SELECT status FROM payments
     WHERE engagement_id = $1
     ORDER BY payment_id DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [engagement.engagement_id]
  );
  if (payRes.rows[0]?.status !== "SUCCESS") return engagement;

  if (["PAYMENT_PENDING", "CREATED", ""].includes(life) || !life) {
    await transitionEngagement(client, {
      engagementId: engagement.engagement_id,
      newStatus: "OPEN_FOR_ACCEPTANCE",
      eventType: "PAYMENT_COMPLETED",
      actorType: "SYSTEM",
      metadata: { source: "ACCEPT_REPAIR" },
    });
    const refreshed = await client.query(
      `SELECT * FROM engagements WHERE engagement_id=$1`,
      [engagement.engagement_id]
    );
    return refreshed.rows[0] || engagement;
  }

  return engagement;
}

function validateProviderCanAccept(e) {
  if (e.serviceproviderid) {
    return { ok: false, status: 409, error: "Already accepted" };
  }

  const life = String(e.engagement_status || "").toUpperCase();
  const assignment = String(e.assignment_status || "").toUpperCase();
  const bookingType = String(e.booking_type || "").toUpperCase();

  if (["CANCELLED", "EXPIRED"].includes(life)) {
    return { ok: false, status: 409, error: "Engagement no longer available" };
  }

  if (bookingType === "ON_DEMAND") {
    if (["PAYMENT_PENDING", "PAYMENT_FAILED"].includes(life)) {
      return { ok: false, status: 409, error: "Payment not completed" };
    }
    if (!ON_DEMAND_ACCEPTABLE_ENGAGEMENT_STATUSES.has(life)) {
      return { ok: false, status: 409, error: "Engagement no longer available" };
    }
    if (assignment !== "UNASSIGNED") {
      return { ok: false, status: 409, error: "Engagement no longer available" };
    }
    return { ok: true };
  }

  if (assignment !== "UNASSIGNED") {
    return { ok: false, status: 409, error: "Engagement no longer available" };
  }
  return { ok: true };
}

router.post("/:id/accept", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const providerId = Number(
      req.body.providerId ?? req.body.serviceproviderid ?? req.user?.id
    );

    if (!Number.isFinite(providerId) || providerId < 1) {
      return res.status(400).json({ error: "Provider ID required" });
    }

    await client.query("BEGIN");

    const engRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`,
      [id]
    );

    if (!engRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }

    let e = engRes.rows[0];
    e = await repairOnDemandEngagementIfPaid(client, e);

    if (String(e.booking_type || "").toUpperCase() !== "ON_DEMAND") {
      const acceptCheck = validateProviderCanAccept(e);
      if (!acceptCheck.ok) {
        await client.query("ROLLBACK");
        return res.status(acceptCheck.status).json({ error: acceptCheck.error });
      }
      if (!e.start_epoch) {
        await client.query("ROLLBACK");
        throw new Error("Engagement timing missing");
      }
      const conflictRow = await findProviderBookedConflict(client, providerId, e, e.engagement_id);
      if (conflictRow) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Provider has time conflict",
          detail: `Conflicts with engagement #${conflictRow.engagement_id} on ${conflictRow.date}`,
        });
      }
      await client.query(
        `UPDATE engagements SET serviceproviderid=$1, assignment_status='ASSIGNED' WHERE engagement_id=$2`,
        [providerId, id]
      );
      await transitionEngagement(client, {
        engagementId: id,
        newStatus: "ASSIGNED",
        eventType: "PROVIDER_ACCEPTED",
        actorType: "PROVIDER",
        actorId: providerId,
      });
      await client.query("COMMIT");
      const updated = (await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])).rows[0];
      return res.json({
        message: "Booking accepted successfully",
        engagement: redactEngagementForProvider(updated),
      });
    }

    let acceptResult;
    try {
      acceptResult = await acceptOnDemandIntoQueue(client, e, providerId);
    } catch (queueErr) {
      await client.query("ROLLBACK");
      return res.status(queueErr.statusCode || 500).json({
        error: queueErr.message,
        detail: queueErr.detail,
      });
    }

    await client.query("COMMIT");

    const updated = acceptResult.engagement;
    const queueCount = await countActiveQueue(pool, id);
    await postAcceptNotifications(id, updated, providerId, acceptResult.role, req.io, {
      queueCountAfterAccept: queueCount,
    });

    const queue = await fetchActiveQueueRows(pool, id);

    return res.json({
      message:
        acceptResult.role === "primary"
          ? "Booking accepted successfully"
          : `Added as backup provider (#${acceptResult.queuePosition} in queue)`,
      role: acceptResult.role,
      queuePosition: acceptResult.queuePosition,
      provider_queue: queue,
      engagement: redactEngagementForProvider(updated),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Accept engagement error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post("/:id/reject", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const providerId = Number(
      req.body.providerId ?? req.body.serviceproviderid ?? req.user?.id
    );
    if (!Number.isFinite(providerId) || providerId < 1) {
      return res.status(400).json({ error: "Provider ID required" });
    }

    await client.query("BEGIN");
    const engRes = await client.query(
      `SELECT engagement_id, booking_type FROM engagements WHERE engagement_id=$1`,
      [id]
    );
    if (!engRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }
    if (String(engRes.rows[0].booking_type || "").toUpperCase() !== "ON_DEMAND") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Reject is only for ON_DEMAND bookings" });
    }

    await declineOnDemandOffer(client, id, providerId);
    await client.query("COMMIT");

    return res.json({ success: true, message: "Booking declined" });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post("/:id/provider-withdraw", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const providerId = Number(
      req.body.providerId ?? req.body.serviceproviderid ?? req.user?.id
    );
    if (!Number.isFinite(providerId) || providerId < 1) {
      return res.status(400).json({ error: "Provider ID required" });
    }

    await client.query("BEGIN");
    const engRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`,
      [id]
    );
    if (!engRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }

    let result;
    try {
      result = await withdrawFromOnDemandQueue(client, engRes.rows[0], providerId, {
        io: req.io,
      });
    } catch (withdrawErr) {
      await client.query("ROLLBACK");
      return res.status(withdrawErr.statusCode || 500).json({ error: withdrawErr.message });
    }

    await client.query("COMMIT");

    const queue = await fetchActiveQueueRows(pool, id);
    return res.json({
      success: true,
      ...result,
      provider_queue: queue,
      engagement: redactEngagementForProvider(result.engagement),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


/**
 * @swagger
 * tags:
 *   name: Engagement V2
 *   description: Production-grade engagement lifecycle APIs
 */

/**
 * @swagger
 * /v2/engagements/{id}/assign:
 *   post:
 *     summary: Assign provider to engagement
 *     tags: [Engagement V2]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Engagement ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - providerId
 *             properties:
 *               providerId:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Provider assigned successfully
 *       400:
 *         description: Invalid request
 */

/**
 * @swagger
 * /v2/engagements/{id}/start:
 *   post:
 *     summary: Start service
 *     tags: [Engagement V2]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Service started successfully
 */

/**
 * @swagger
 * /v2/engagements/{id}/complete:
 *   post:
 *     summary: Complete service
 *     tags: [Engagement V2]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Service completed successfully
 */

/**
 * @swagger
 * /v2/engagements/{id}/cancel:
 *   post:
 *     summary: Cancel engagement
 *     tags: [Engagement V2]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Engagement cancelled successfully
 */

/**
 * @swagger
 * /v2/engagements/{id}/history:
 *   get:
 *     summary: Get engagement lifecycle history
 *     tags: [Engagement V2]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Engagement history fetched
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 history:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       event_id:
 *                         type: integer
 *                       from_status:
 *                         type: string
 *                       to_status:
 *                         type: string
 *                       event_type:
 *                         type: string
 *                       actor_type:
 *                         type: string
 *                       actor_id:
 *                         type: integer
 *                       metadata:
 *                         type: object
 *                       created_at:
 *                         type: string
 *                         format: date-time
 */

/**
 * @swagger
 * /v2/engagements/{id}/accept:
 *   post:
 *     summary: Provider accepts an ON_DEMAND engagement
 *     tags:
 *       - Engagements V2
 *     description: |
 *       Allows a service provider to accept an ON_DEMAND engagement.
 *       Only works if:
 *       - Booking type is ON_DEMAND
 *       - Engagement is not already assigned
 *       - Payment is completed
 *       - Provider has no overlapping bookings
 *
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Engagement ID
 *         schema:
 *           type: integer
 *
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - serviceproviderid
 *             properties:
 *               serviceproviderid:
 *                 type: integer
 *                 example: 3403
 *
 *     responses:
 *       200:
 *         description: Booking accepted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Booking accepted successfully
 *
 *       400:
 *         description: Business validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   examples:
 *                     alreadyAssigned:
 *                       value: Engagement already accepted
 *                     paymentIncomplete:
 *                       value: Payment not completed
 *                     notOnDemand:
 *                       value: Only ON_DEMAND can be accepted
 *                     overlap:
 *                       value: Provider not available at this time
 *
 *       404:
 *         description: Engagement not found
 *
 *       500:
 *         description: Internal server error
 */


export default router;