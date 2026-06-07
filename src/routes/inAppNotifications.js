import express from "express";
import {
  getUnreadCount,
  listInAppNotifications,
  markAllRead,
  markNotificationRead,
} from "../services/inAppNotification.service.js";
import {
  authenticateRead,
  loadActor,
  requireNotificationRecipient,
} from "../middleware/resourceAccess.js";

const router = express.Router();

const notificationRead = [authenticateRead, loadActor, requireNotificationRecipient];

function parseRecipient(req) {
  const q = req.query && typeof req.query === "object" ? req.query : {};
  const b =
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const merged = { ...q, ...b };
  const recipientType = String(
    merged.recipientType || merged.recipient_type || ""
  ).toLowerCase();
  const rawId = merged.recipientId ?? merged.recipient_id;
  const recipientId = rawId != null && rawId !== "" ? Number(rawId) : NaN;
  if (recipientType !== "customer" && recipientType !== "provider") {
    return { error: { status: 400, message: "recipientType must be customer or provider" } };
  }
  if (!Number.isFinite(recipientId) || recipientId < 1) {
    return { error: { status: 400, message: "recipientId is required" } };
  }
  return { recipientType, recipientId };
}

router.get("/in-app-notifications", ...notificationRead, async (req, res) => {
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
    console.error("in-app-notifications list", err?.message || err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

router.get("/in-app-notifications/unread-count", ...notificationRead, async (req, res) => {
  const parsed = parseRecipient(req);
  if (parsed.error) {
    return res.status(parsed.error.status).json({ error: parsed.error.message });
  }
  const { recipientType, recipientId } = parsed;
  try {
    const count = await getUnreadCount({ recipientType, recipientId });
    return res.json({ count });
  } catch (err) {
    console.error("in-app-notifications count", err?.message || err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

router.patch("/in-app-notifications/:id/read", ...notificationRead, async (req, res) => {
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
