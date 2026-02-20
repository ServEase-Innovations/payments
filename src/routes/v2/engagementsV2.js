import express from "express";
import pool from "../../config/db.js";
import Razorpay from "razorpay";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import geolib from "geolib";
import { io } from "../../../index.js";
import { createServiceDays } from "../serviceDays.service.js";

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
    const providerId = req.user.id;

    await client.query("BEGIN");

    // Lock row
    const engRes = await client.query(
      `SELECT engagement_status
       FROM engagements
       WHERE engagement_id=$1
       FOR UPDATE`,
      [id]
    );

    if (engRes.rows.length === 0)
      throw new Error("Engagement not found");

    const status = engRes.rows[0].engagement_status;

    if (status !== "OPEN_FOR_ACCEPTANCE") {
      throw new Error("Engagement no longer available");
    }

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
      eventType: "PROVIDER_ACCEPTED",
      actorType: "PROVIDER",
      actorId: providerId
    });

    await client.query("COMMIT");

    res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
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




export default router;