import pool from "../config/db.js";
import { getSocketServer } from "../utils/socketIoRef.js";

const ALLOWED_RECIPIENT = new Set(["customer", "provider"]);

/**
 * @param {import('socket.io').Server | undefined | null} io
 * @param {object} params
 */
function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

export function formatRow(row) {
  return {
    id: String(row.id),
    recipientType: row.recipient_type,
    recipientId: String(row.recipient_id),
    type: row.type,
    title: row.title,
    body: row.body,
    engagementId: row.engagement_id != null ? String(row.engagement_id) : null,
    metadata: row.metadata,
    readAt: toIso(row.read_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

/**
 * @param {object} params
 * @param {import('socket.io').Server | null | undefined} [params.io]
 * @param {'customer'|'provider'} params.recipientType
 * @param {number} params.recipientId
 * @param {string} params.type
 * @param {string} params.title
 * @param {string} [params.body]
 * @param {number|null} [params.engagementId]
 * @param {object|null} [params.metadata]
 */
export async function createInAppNotification({
  io: ioOverride = null,
  recipientType,
  recipientId,
  type,
  title,
  body = "",
  engagementId = null,
  metadata = null,
}) {
  if (!ALLOWED_RECIPIENT.has(recipientType)) {
    throw new Error("Invalid recipientType");
  }
  const id = Number(recipientId);
  if (!Number.isFinite(id) || id < 1) {
    throw new Error("Invalid recipientId");
  }

  const { rows } = await pool.query(
    `
    INSERT INTO in_app_notifications
      (recipient_type, recipient_id, type, title, body, engagement_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [recipientType, id, type, title, body || "", engagementId, metadata]
  );

  const row = rows[0];
  const io = ioOverride != null ? ioOverride : getSocketServer();
  const room =
    recipientType === "customer" ? `customer_${id}` : `provider_${id}`;

  if (io) {
    io.to(room).emit("in_app_notification", formatRow(row));
  }
  return row;
}

export async function getUnreadCount({ recipientType, recipientId }) {
  if (!ALLOWED_RECIPIENT.has(recipientType)) {
    throw new Error("Invalid recipientType");
  }
  const id = Number(recipientId);
  if (!Number.isFinite(id) || id < 1) {
    return 0;
  }
  const { rows } = await pool.query(
    `
    SELECT count(*)::int AS c
    FROM in_app_notifications
    WHERE recipient_type = $1
      AND recipient_id = $2
      AND read_at IS NULL
    `,
    [recipientType, id]
  );
  return rows[0].c;
}

/**
 * @param {object} params
 * @param {number} [params.limit=40]
 * @param {number} [params.offset=0]
 * @param {boolean} [params.unreadOnly=false]
 */
export async function listInAppNotifications({
  recipientType,
  recipientId,
  limit = 40,
  offset = 0,
  unreadOnly = false,
}) {
  if (!ALLOWED_RECIPIENT.has(recipientType)) {
    throw new Error("Invalid recipientType");
  }
  const id = Number(recipientId);
  if (!Number.isFinite(id) || id < 1) {
    return { items: [], unreadCount: 0 };
  }

  const [listRes, unreadRes] = await Promise.all([
    pool.query(
      `
      SELECT *
      FROM in_app_notifications
      WHERE recipient_type = $1
        AND recipient_id = $2
        ${unreadOnly ? "AND read_at IS NULL" : ""}
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4
      `,
      [recipientType, id, Math.min(100, Math.max(1, limit)), Math.max(0, offset)]
    ),
    pool.query(
      `
      SELECT count(*)::int AS c
      FROM in_app_notifications
      WHERE recipient_type = $1
        AND recipient_id = $2
        AND read_at IS NULL
      `,
      [recipientType, id]
    ),
  ]);

  return {
    items: listRes.rows.map(formatRow),
    unreadCount: unreadRes.rows[0].c,
  };
}

export async function markNotificationRead({
  recipientType,
  recipientId,
  notificationId,
}) {
  if (!ALLOWED_RECIPIENT.has(recipientType)) {
    throw new Error("Invalid recipientType");
  }
  const nId = Number(notificationId);
  if (!Number.isFinite(nId) || nId < 1) {
    return null;
  }
  const { rows } = await pool.query(
    `
    UPDATE in_app_notifications
    SET read_at = NOW()
    WHERE id = $1
      AND recipient_type = $2
      AND recipient_id = $3
    RETURNING *
    `,
    [nId, recipientType, Number(recipientId)]
  );
  return rows[0] ? formatRow(rows[0]) : null;
}

export async function markAllRead({ recipientType, recipientId }) {
  if (!ALLOWED_RECIPIENT.has(recipientType)) {
    throw new Error("Invalid recipientType");
  }
  await pool.query(
    `
    UPDATE in_app_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE recipient_type = $1
      AND recipient_id = $2
      AND read_at IS NULL
    `,
    [recipientType, Number(recipientId)]
  );
  return { ok: true };
}

export const InAppTypes = {
  NEW_BOOKING_OPPORTUNITY: "NEW_BOOKING_OPPORTUNITY",
  NEW_BOOKING_REQUEST: "NEW_BOOKING_REQUEST",
  /** MONTHLY / SHORT_TERM: payment succeeded and engagement is assigned to this provider */
  ASSIGNED_BOOKING_CONFIRMED: "ASSIGNED_BOOKING_CONFIRMED",
  BOOKING_ACCEPTED: "BOOKING_ACCEPTED",
  SERVICE_DAY_STARTED: "SERVICE_DAY_STARTED",
  SERVICE_DAY_COMPLETED: "SERVICE_DAY_COMPLETED",
};

/**
 * When one provider accepts an on-demand request, all other providers should not keep an unread
 * "new booking" row for the same engagement.
 */
export async function dismissNewBookingInAppByEngagementId(engagementId) {
  const eid = Number(engagementId);
  if (!Number.isFinite(eid) || eid < 1) return { updated: 0 };
  const r = await pool.query(
    `
    UPDATE in_app_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE engagement_id = $1
      AND recipient_type = 'provider'
      AND type IN ($2, $3)
    `,
    [eid, InAppTypes.NEW_BOOKING_OPPORTUNITY, InAppTypes.NEW_BOOKING_REQUEST]
  );
  return { updated: r.rowCount ?? 0 };
}

const NEW_BOOKING_TYPES = [
  InAppTypes.NEW_BOOKING_OPPORTUNITY,
  InAppTypes.NEW_BOOKING_REQUEST,
];

/**
 * One actionable "new booking" row per provider per engagement (replaces stale unread duplicates).
 */
export async function upsertProviderNewBookingNotification({
  io = null,
  recipientId,
  engagementId,
  title,
  body = "",
  metadata = null,
}) {
  const spid = Number(recipientId);
  const eid = Number(engagementId);
  if (!Number.isFinite(spid) || spid < 1 || !Number.isFinite(eid) || eid < 1) {
    throw new Error("Invalid provider or engagement id");
  }

  await pool.query(
    `
    UPDATE in_app_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE engagement_id = $1
      AND recipient_type = 'provider'
      AND recipient_id = $2
      AND type = ANY($3::text[])
      AND read_at IS NULL
    `,
    [eid, spid, NEW_BOOKING_TYPES]
  );

  return createInAppNotification({
    io,
    recipientType: "provider",
    recipientId: spid,
    type: InAppTypes.NEW_BOOKING_OPPORTUNITY,
    title,
    body,
    engagementId: eid,
    metadata,
  });
}

/** Notify all connected provider clients to close booking-request UI for this engagement. */
export function emitBookingRequestClosed(io, engagementId, reason = "accepted") {
  if (!io) return;
  const eid = Number(engagementId);
  if (!Number.isFinite(eid) || eid < 1) return;
  io.emit("booking-request-closed", { engagement_id: eid, reason });
}
