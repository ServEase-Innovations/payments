import express from "express";
import "../config/config.js";
import {
  createInAppNotification,
  formatRow,
} from "../services/inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";

const router = express.Router();

/** Same as services/tickets `DEV_ADMIN_SECRET` and utils `.env.example`. */
const DEV_INTERNAL_SECRET = "serveaso-test-push-secret";

function resolveExpectedInternalSecret() {
  const fromEnv = (
    process.env.INTERNAL_NOTIFY_SECRET ||
    process.env.ADMIN_PUSH_SECRET ||
    process.env.ADMIN_TICKET_SECRET ||
    ""
  ).trim();
  if (fromEnv) return fromEnv;
  const env = process.env.NODE_ENV || "development";
  if (env === "development") return DEV_INTERNAL_SECRET;
  return "";
}

function checkInternalSecret(req, res, next) {
  const provided = String(req.headers["x-internal-secret"] || "").trim();
  const expected = resolveExpectedInternalSecret();
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/** Service-to-service: create notification + Socket.IO emit (tickets, etc.) */
router.post("/internal/in-app-notifications", checkInternalSecret, async (req, res) => {
  try {
    const {
      recipientType,
      recipientId,
      type,
      title,
      body,
      engagementId,
      metadata,
    } = req.body || {};

    const row = await createInAppNotification({
      recipientType,
      recipientId: Number(recipientId),
      type,
      title,
      body: body || "",
      engagementId: engagementId != null ? Number(engagementId) : null,
      metadata: metadata ?? null,
    });
    return res.status(201).json({ notification: formatRow(row) });
  } catch (err) {
    console.error("[internal] in-app-notifications", err?.message || err);
    return res.status(400).json({ error: err.message || "Invalid request" });
  }
});

/** Real-time support-ticket events for admin dashboard (no DB row). */
router.post("/internal/support-ticket-activity", checkInternalSecret, (req, res) => {
  const {
    ticketId,
    ticketNumber,
    title,
    body,
    reason,
    status,
    customerId,
  } = req.body || {};

  const id = Number(ticketId);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ error: "ticketId is required" });
  }

  const payload = {
    ticketId: id,
    ticketNumber: ticketNumber || null,
    title: title || "Support ticket",
    body: body || "",
    reason: reason || "activity",
    status: status || null,
    customerId: customerId != null ? Number(customerId) : null,
    createdAt: new Date().toISOString(),
  };

  const io = getSocketServer();
  if (io) {
    io.to("admins").emit("support_ticket_activity", payload);
  }

  return res.json({ ok: true });
});

export default router;
