import express from "express";
import pool from "../../config/db.js";
import { transitionEngagement } from "../../services/engagementLifecycle.js";
import Razorpay from "razorpay";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import geolib from "geolib";
import { io } from "../../../index.js";
import { createServiceDays } from "../serviceDays.service.js";

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
    const { providerId } = req.body;

    await client.query("BEGIN");

    await client.query(
      `UPDATE engagements
       SET serviceproviderid=$1,
           assignment_status='ASSIGNED'
       WHERE engagement_id=$2`,
      [providerId, id]
    );

    await transitionEngagement(client, {
      engagementId: id,
      newStatus: "ASSIGNED",
      eventType: "PROVIDER_ASSIGNED",
      actorType: "ADMIN",
      actorId: req.user?.id || null,
      metadata: { providerId }
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


router.post("/:id/accept", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const providerId =
      req.body.providerId ??
      req.body.serviceproviderid ??
      req.user?.id;

    if (!providerId) {
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

    const e = engRes.rows[0];

    // 🔥 Correct status check
    if (e.engagement_status !== "UNASSIGNED") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Engagement no longer available",
      });
    }

    if (e.serviceproviderid) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Already accepted",
      });
    }

    if (!e.start_epoch || !e.end_epoch) {
      await client.query("ROLLBACK");
      throw new Error("Engagement timing missing");
    }

    // 🔎 Overlap check
    const conflict = await client.query(
      `
      SELECT 1
      FROM provider_availability
      WHERE serviceproviderid=$1
        AND $2 < slot_end_epoch
        AND $3 > slot_start_epoch
      LIMIT 1
      `,
      [providerId, e.start_epoch, e.end_epoch]
    );

    if (conflict.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Provider has time conflict",
      });
    }

    // ✅ Assign provider
    await client.query(
      `UPDATE engagements
       SET serviceproviderid=$1,
           assignment_status='ASSIGNED'
       WHERE engagement_id=$2`,
      [providerId, id]
    );

    // 🔁 Lifecycle transition
    await transitionEngagement(client, {
      engagementId: id,
      newStatus: "ASSIGNED",
      eventType: "PROVIDER_ACCEPTED",
      actorType: "PROVIDER",
      actorId: providerId,
    });

    await client.query("COMMIT");

    const updated = (
      await pool.query(
        `SELECT * FROM engagements WHERE engagement_id=$1`,
        [id]
      )
    ).rows[0];

    return res.json({
      message: "Engagement accepted successfully",
      engagement: updated,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Accept engagement error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


router.post("/:id/accept", async (req, res) => {
  const client = await pool.connect();

  try {
    const engagementId = req.params.id;
    const { serviceproviderid } = req.body;

    if (!serviceproviderid) {
      return res.status(400).json({ error: "Provider ID required" });
    }

    await client.query("BEGIN");

    // 🔒 Lock engagement row
    const engagementRes = await client.query(
      `SELECT * FROM engagements
       WHERE engagement_id=$1
       FOR UPDATE`,
      [engagementId]
    );

    if (!engagementRes.rows.length) {
      throw new Error("Engagement not found");
    }

    const engagement = engagementRes.rows[0];

    // 🛑 Must be ON_DEMAND
    if (engagement.booking_type !== "ON_DEMAND") {
      throw new Error("Only ON_DEMAND can be accepted");
    }

    // 🛑 Already assigned?
    if (engagement.serviceproviderid) {
      throw new Error("Engagement already accepted");
    }

    // 🛑 Payment must be successful
    if (engagement.engagement_status !== "PAYMENT_SUCCESS") {
      throw new Error("Payment not completed");
    }

    // 🛑 Expired?
    if (engagement.engagement_status === "EXPIRED") {
      throw new Error("Engagement expired");
    }

    // 🔍 Overlap check
    const overlap = await client.query(
      `
      SELECT 1
      FROM provider_availability
      WHERE serviceproviderid=$1
        AND $2 < slot_end_epoch
        AND $3 > slot_start_epoch
      LIMIT 1
      `,
      [
        serviceproviderid,
        engagement.start_epoch,
        engagement.end_epoch
      ]
    );

    if (overlap.rows.length) {
      throw new Error("Provider not available at this time");
    }

    // ✅ Assign provider
    await client.query(
      `
      UPDATE engagements
      SET serviceproviderid=$1,
          assignment_status='ASSIGNED'
      WHERE engagement_id=$2
      `,
      [serviceproviderid, engagementId]
    );

    // 🔁 Lifecycle → ASSIGNED (will block availability)
    await transitionEngagement(client, {
      engagementId,
      newStatus: "ASSIGNED",
      eventType: "PROVIDER_ACCEPTED",
      actorType: "PROVIDER",
      actorId: serviceproviderid,
    });

    await client.query("COMMIT");

    // 🔔 Notify customer
    req.io.to(`customer_${engagement.customerid}`)
      .emit("engagement-accepted", {
        engagement_id: engagementId,
        serviceproviderid
      });

    return res.json({
      success: true,
      message: "Engagement accepted"
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Accept error:", err);
    return res.status(400).json({ error: err.message });
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
 * /api/v2/engagements/{id}/assign:
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
 * /api/v2/engagements/{id}/start:
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
 * /api/v2/engagements/{id}/complete:
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
 * /api/v2/engagements/{id}/cancel:
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
 *         description: Engagement accepted successfully
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
 *                   example: Engagement accepted
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