import express from "express";
import {
  getUnreadCount,
  listInAppNotifications,
  markAllRead,
  markNotificationRead,
} from "../services/inAppNotification.service.js";

const router = express.Router();

function parseRecipient(req) {
  const recipientType = String(
    req.query.recipientType || req.query.recipient_type || ""
  ).toLowerCase();
  const rawId = req.query.recipientId ?? req.query.recipient_id;
  const recipientId = rawId != null && rawId !== "" ? Number(rawId) : NaN;
  if (recipientType !== "customer" && recipientType !== "provider") {
    return { error: { status: 400, message: "recipientType must be customer or provider" } };
  }
  if (!Number.isFinite(recipientId) || recipientId < 1) {
    return { error: { status: 400, message: "recipientId is required" } };
  }
  return { recipientType, recipientId };
}

router.get("/in-app-notifications", async (req, res) => {
  const parsed = parseRecipient(req);
  if (parsed.error) {
    return res.status(parsed.error.status).json({ error: parsed.error.message });
  }
  const { recipientType, recipientId } = parsed;
  const limit = Number(req.query.limit) || 40;
  const offset = Number(req.query.offset) || 0;
  const unreadOnly = String(req.query.unreadOnly) === "1" || String(req.query.unreadOnly) === "true";
  try {
    const { items, unreadCount } = await listInAppNotifications({
      recipientType,
      recipientId,
      limit,
      offset,
      unreadOnly,
    });
    return res.json({ notifications: items, unreadCount });
  } catch (err) {
    console.error("in-app-notifications list", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

router.get("/in-app-notifications/unread-count", async (req, res) => {
  const parsed = parseRecipient(req);
  if (parsed.error) {
    return res.status(parsed.error.status).json({ error: parsed.error.message });
  }
  const { recipientType, recipientId } = parsed;
  try {
    const count = await getUnreadCount({ recipientType, recipientId });
    return res.json({ count });
  } catch (err) {
    console.error("in-app-notifications count", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

router.patch("/in-app-notifications/:id/read", async (req, res) => {
  const parsed = parseRecipient(req);
  if (parsed.error) {
    return res.status(parsed.error.status).json({ error: parsed.error.message });
  }
  const { recipientType, recipientId } = parsed;
  try {
    const row = await markNotificationRead({
      recipientType,
      recipientId,
      notificationId: req.params.id,
    });
    if (!row) {
      return res.status(404).json({ error: "Not found" });
    }
    return res.json({ notification: row });
  } catch (err) {
    console.error("in-app-notifications read", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

router.post("/in-app-notifications/read-all", async (req, res) => {
  const merged = { ...req.query, ...req.body };
  const fakeReq = { query: merged };
  const parsed = parseRecipient(fakeReq);
  if (parsed.error) {
    return res.status(parsed.error.status).json({ error: parsed.error.message });
  }
  const { recipientType, recipientId } = parsed;
  try {
    await markAllRead({ recipientType, recipientId });
    return res.json({ ok: true });
  } catch (err) {
    console.error("in-app-notifications read-all", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

export default router;
