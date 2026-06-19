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
      `SELECT booking_type, start_epoch, start_date, engagement_status
       FROM engagements
       WHERE engagement_id = $1`,
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

    await transitionEngagement(client, {
      engagementId: id,
      newStatus: "CANCELLED",
      eventType: "ENGAGEMENT_CANCELLED",
      actorType: "CUSTOMER",
      actorId: req.user?.id,
      metadata: { reason }
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