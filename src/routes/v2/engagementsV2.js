import express from "express";
import pool from "../../config/db.js";
import { transitionEngagement } from "../../services/engagementLifecycle.js";
import Razorpay from "razorpay";
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
    
    // Get engagement details
    const engRes = await client.query(
      `SELECT e.engagement_id, e.booking_type, e.serviceproviderid, e.service_type,
              e.end_epoch, e.engagement_status, e.task_status,
              e.start_epoch, e.base_amount, e.duration_minutes
       FROM engagements e
       WHERE e.engagement_id = $1`,
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
    const currentEndEpoch = Number(engagement.end_epoch);
    const maxCheckHours = 4; // Check up to 4 hours ahead
    const maxCheckEpoch = currentEndEpoch + (maxCheckHours * 3600);
    
    const conflictRes = await client.query(
      `SELECT e.engagement_id, e.start_epoch, e.end_epoch, e.task_status
       FROM engagements e
       WHERE e.serviceproviderid = $1
         AND e.engagement_id != $2
         AND e.task_status NOT IN ('CANCELLED', 'COMPLETED')
         AND (
           (e.start_epoch >= $3 AND e.start_epoch < $4) OR
           (e.end_epoch > $3 AND e.end_epoch <= $4) OR
           (e.start_epoch <= $3 AND e.end_epoch >= $4)
         )
       ORDER BY e.start_epoch
       LIMIT 1`,
      [engagement.serviceproviderid, id, currentEndEpoch, maxCheckEpoch]
    );
    
    let maxExtensionHours = maxCheckHours;
    
    // If there's a conflict, calculate max hours until conflict
    if (conflictRes.rows.length > 0) {
      const nextBooking = conflictRes.rows[0];
      const hoursDiff = (Number(nextBooking.start_epoch) - currentEndEpoch) / 3600;
      maxExtensionHours = Math.floor(hoursDiff);
    }
    
    // Calculate hourly rate
    const durationMinutes = Number(engagement.duration_minutes) || 60;
    const baseAmount = Number(engagement.base_amount) || 0;
    const hourlyRate = durationMinutes > 0 ? (baseAmount / (durationMinutes / 60)) : baseAmount;
    
    // Generate available slots
    const availableSlots = [];
    for (let hours = 1; hours <= maxExtensionHours; hours++) {
      const newEndEpoch = currentEndEpoch + (hours * 3600);
      const newEndTime = dayjs.unix(newEndEpoch).tz("Asia/Kolkata");
      
      availableSlots.push({
        hours,
        newEndTime: newEndTime.toISOString(),
        newEndTimeFormatted: newEndTime.format("DD MMM YYYY, hh:mm A"),
        additionalCost: Math.round(hourlyRate * hours * 100) / 100,
        totalCost: Math.round((baseAmount + hourlyRate * hours) * 100) / 100
      });
    }
    
    res.json({
      success: true,
      canExtend: maxExtensionHours > 0,
      maxExtensionHours,
      providerAvailable: true,
      currentEndTime: dayjs.unix(currentEndEpoch).tz("Asia/Kolkata").toISOString(),
      currentEndTimeFormatted: dayjs.unix(currentEndEpoch).tz("Asia/Kolkata").format("DD MMM YYYY, hh:mm A"),
      hourlyRate: Math.round(hourlyRate * 100) / 100,
      availableSlots,
      reason: maxExtensionHours > 0 ? null : "Provider has conflicting bookings"
    });
    
  } catch (err) {
    console.error("[extension-availability] Error:", err);
    res.status(500).json({ error: "Failed to check extension availability" });
  } finally {
    client.release();
  }
});

/**
 * Extend booking with additional hours
 * POST /api/v2/engagements/:id/extend
 */
router.post("/:id/extend", async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { extensionHours, newEndTime, additionalAmount, paymentMode } = req.body;
    
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
      `SELECT e.*, p.total_amount as payment_total
       FROM engagements e
       LEFT JOIN payments p ON p.engagement_id = e.engagement_id AND p.status = 'SUCCESS'
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
    
    // Check for conflicts again (prevent race conditions)
    const newEndEpoch = dayjs(newEndTime).unix();
    const currentEndEpoch = Number(engagement.end_epoch);
    
    const conflictCheck = await client.query(
      `SELECT engagement_id FROM engagements
       WHERE serviceproviderid = $1
         AND engagement_id != $2
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
    
    // Store original end time if this is first extension
    const originalEndEpoch = engagement.original_end_epoch || engagement.end_epoch;
    const extensionCount = (engagement.extension_count || 0) + 1;
    
    // Update engagement
    await client.query(
      `UPDATE engagements
       SET end_time = $1,
           end_epoch = $2,
           base_amount = base_amount + $3,
           extension_count = $4,
           original_end_epoch = $5,
           last_extended_at = NOW(),
           updated_at = NOW()
       WHERE engagement_id = $6`,
      [
        dayjs(newEndTime).tz("Asia/Kolkata").format("HH:mm"),
        newEndEpoch,
        additionalAmount,
        extensionCount,
        originalEndEpoch,
        id
      ]
    );
    
    // Create payment record for extension
    await client.query(
      `INSERT INTO payments (
        engagement_id, customerid, total_amount, base_amount,
        payment_mode, status, payment_type, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'SUCCESS', 'EXTENSION', NOW())`,
      [
        id,
        engagement.customerid,
        additionalAmount,
        additionalAmount,
        paymentMode || 'CASH'
      ]
    );
    
    // Log extension event
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
          old_end_epoch: currentEndEpoch,
          new_end_epoch: newEndEpoch,
          extension_count: extensionCount
        })
      ]
    );
    
    // Create notification for provider
    await createInAppNotification(client, {
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
        newEndTime,
        extensionCount
      }
    });
    
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[extend-booking] Error:", err);
    res.status(500).json({ error: "Failed to extend booking" });
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