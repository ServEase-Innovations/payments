import pool from "../config/db.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import { enrichAutoCancelNotificationMetadata } from "./bookingNotificationMetadata.js";

const ALLOWED_RECIPIENT = new Set(["customer", "provider"]);

const POSTGRES_CONNECTIVITY_CODES = new Set([
  "ETIMEDOUT",
  "ENETUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

export function isPostgresConnectivityError(err) {
  return POSTGRES_CONNECTIVITY_CODES.has(err?.code);
}

let loggedDbUnavailable = false;

function warnDbUnavailable(context, err) {
  if (loggedDbUnavailable) return;
  loggedDbUnavailable = true;
  console.warn(
    `[in-app-notifications] Postgres unreachable (${err?.code || "unknown"}); ${context}. ` +
      "Check POSTGRES_HOST / VPN. Read endpoints return empty data until DB is reachable."
  );
}

/**
 * @param {import('socket.io').Server | undefined | null} io
 * @param {object} params
 */
function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

const NEW_BOOKING_TYPES = ["NEW_BOOKING_OPPORTUNITY", "NEW_BOOKING_REQUEST"];

const OPEN_FOR_ACCEPTANCE_STATUSES = new Set([
  "OPEN_FOR_ACCEPTANCE",
  "UNASSIGNED",
  "CRM_ESCALATED",
  "",
]);

const TERMINAL_ENGAGEMENT_STATUSES = new Set([
  "CANCELLED",
  "EXPIRED",
  "COMPLETED",
  "CLOSED",
  "REJECTED",
]);

/**
 * For provider "new booking" rows, derive whether Accept/Decline should still show.
 * @param {object} row — notification row; may include joined `eng_*` engagement columns
 */
function deriveBookingNotificationAction(row) {
  const type = String(row.type || "");
  if (!NEW_BOOKING_TYPES.includes(type)) return null;

  const eid = row.engagement_id != null ? Number(row.engagement_id) : NaN;
  if (!Number.isFinite(eid) || eid < 1) {
    return { bookingActionable: false, bookingClosureLabel: "Already accepted" };
  }

  const engStatus = String(
    row.eng_engagement_status ?? row.engagement_status ?? ""
  ).toUpperCase();
  const assignStatus = String(
    row.eng_assignment_status ?? row.assignment_status ?? ""
  ).toUpperCase();
  const assignedSpRaw = row.eng_serviceproviderid ?? row.serviceproviderid;
  const assignedSp =
    assignedSpRaw != null && assignedSpRaw !== ""
      ? Number(assignedSpRaw)
      : null;
  const bookingType = String(
    row.eng_booking_type ?? row.booking_type ?? ""
  ).toUpperCase();

  if (TERMINAL_ENGAGEMENT_STATUSES.has(engStatus)) {
    return { bookingActionable: false, bookingClosureLabel: "Already accepted" };
  }

  if (Number.isFinite(assignedSp) && assignedSp > 0) {
    return { bookingActionable: false, bookingClosureLabel: "Already accepted" };
  }

  if (assignStatus && assignStatus !== "UNASSIGNED") {
    return { bookingActionable: false, bookingClosureLabel: "Already accepted" };
  }

  const isOnDemand = bookingType === "ON_DEMAND" || bookingType === "";
  if (isOnDemand && !OPEN_FOR_ACCEPTANCE_STATUSES.has(engStatus)) {
    return { bookingActionable: false, bookingClosureLabel: "Already accepted" };
  }

  return { bookingActionable: true, bookingClosureLabel: null };
}

function resolveNotificationMetadata(row) {
  const type = String(row.type || "").toUpperCase();
  if (
    type === "BOOKING_AUTO_CANCELLED_NO_PROVIDER" ||
    type === "BOOKING_AUTO_CANCELLED_PAYMENT_TIMEOUT"
  ) {
    return enrichAutoCancelNotificationMetadata(row);
  }
  const raw = row.metadata;
  if (raw != null && typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* keep raw */
    }
  }
  return raw;
}

export function formatRow(row) {
  const out = {
    id: String(row.id),
    recipientType: row.recipient_type,
    recipientId: String(row.recipient_id),
    type: row.type,
    title: row.title,
    body: row.body,
    engagementId: row.engagement_id != null ? String(row.engagement_id) : null,
    metadata: resolveNotificationMetadata(row),
    readAt: toIso(row.read_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };

  const action = deriveBookingNotificationAction(row);
  if (action) {
    out.bookingActionable = action.bookingActionable;
    out.bookingClosureLabel = action.bookingClosureLabel;
  }

  return out;
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
  try {
    if (recipientType === "provider") {
      await autoDismissStaleProviderBookingNotifications(id);
    } else if (recipientType === "customer") {
      await autoDismissStaleCustomerPaymentPendingReminders(id);
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
    loggedDbUnavailable = false;
    return rows[0].c;
  } catch (err) {
    if (isPostgresConnectivityError(err)) {
      warnDbUnavailable("unread count", err);
      return 0;
    }
    throw err;
  }
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

  try {
    if (recipientType === "provider") {
      await autoDismissStaleProviderBookingNotifications(id);
    } else if (recipientType === "customer") {
      await autoDismissStaleCustomerPaymentPendingReminders(id);
    }

    const [listRes, unreadRes] = await Promise.all([
      pool.query(
        `
        SELECT
          n.*,
          e.engagement_status AS eng_engagement_status,
          e.assignment_status AS eng_assignment_status,
          e.serviceproviderid AS eng_serviceproviderid,
          e.booking_type AS eng_booking_type,
          e.service_type AS eng_service_type,
          e.start_epoch AS eng_start_epoch,
          e.end_epoch AS eng_end_epoch,
          e.start_date AS eng_start_date,
          e.end_date AS eng_end_date,
          e.duration_minutes AS eng_duration_minutes,
          e.address AS eng_address,
          e.base_amount AS eng_base_amount,
          p.total_amount AS pay_total_amount
        FROM in_app_notifications n
        LEFT JOIN engagements e ON e.engagement_id = n.engagement_id
        LEFT JOIN payments p ON p.engagement_id = n.engagement_id
          AND UPPER(COALESCE(p.status, '')) IN ('SUCCESS', 'REFUNDED')
        WHERE n.recipient_type = $1
          AND n.recipient_id = $2
          ${unreadOnly ? "AND n.read_at IS NULL" : ""}
        ORDER BY n.created_at DESC
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

    loggedDbUnavailable = false;
    return {
      items: listRes.rows.map(formatRow),
      unreadCount: unreadRes.rows[0].c,
    };
  } catch (err) {
    if (isPostgresConnectivityError(err)) {
      warnDbUnavailable("list", err);
      return { items: [], unreadCount: 0 };
    }
    throw err;
  }
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
  SERVICE_START_OVERDUE: "SERVICE_START_OVERDUE",
  /** Customer: payment still PENDING after booking creation */
  PAYMENT_PENDING_REMINDER: "PAYMENT_PENDING_REMINDER",
  /** Customer: paid on-demand booking auto-cancelled — no provider before start */
  BOOKING_AUTO_CANCELLED_NO_PROVIDER: "BOOKING_AUTO_CANCELLED_NO_PROVIDER",
  /** Customer: CRM escalated but provider not yet assigned before start */
  ON_DEMAND_ASSIGNMENT_PENDING: "ON_DEMAND_ASSIGNMENT_PENDING",
  /** Customer: unpaid booking auto-cancelled after payment window elapsed */
  BOOKING_AUTO_CANCELLED_PAYMENT_TIMEOUT: "BOOKING_AUTO_CANCELLED_PAYMENT_TIMEOUT",
  SUPPORT_TICKET_UPDATE: "SUPPORT_TICKET_UPDATE",
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

/**
 * Mark unread provider "new booking" rows read when the engagement is no longer actionable
 * or the notification is too old to show as an Accept/Decline popup.
 */
export async function autoDismissStaleProviderBookingNotifications(providerId) {
  const spid = Number(providerId);
  if (!Number.isFinite(spid) || spid < 1) return { updated: 0 };

  const r = await pool.query(
    `
    UPDATE in_app_notifications n
    SET read_at = COALESCE(n.read_at, NOW())
    FROM engagements e
    WHERE n.recipient_type = 'provider'
      AND n.recipient_id = $1
      AND n.read_at IS NULL
      AND n.type = ANY($2::text[])
      AND n.engagement_id = e.engagement_id
      AND (
        e.serviceproviderid IS NOT NULL
        OR UPPER(COALESCE(e.engagement_status, '')) IN (
          'CANCELLED', 'EXPIRED', 'COMPLETED', 'CLOSED', 'REJECTED'
        )
        OR (
          UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
          AND UPPER(COALESCE(e.engagement_status, '')) NOT IN (
            'OPEN_FOR_ACCEPTANCE', 'UNASSIGNED', ''
          )
        )
        OR UPPER(COALESCE(e.assignment_status, '')) NOT IN ('UNASSIGNED', '')
        OR n.created_at < NOW() - INTERVAL '4 hours'
      )
    `,
    [spid, NEW_BOOKING_TYPES]
  );

  const orphaned = await pool.query(
    `
    UPDATE in_app_notifications n
    SET read_at = COALESCE(n.read_at, NOW())
    WHERE n.recipient_type = 'provider'
      AND n.recipient_id = $1
      AND n.read_at IS NULL
      AND n.type = ANY($2::text[])
      AND (
        n.engagement_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM engagements e WHERE e.engagement_id = n.engagement_id
        )
        OR n.created_at < NOW() - INTERVAL '24 hours'
      )
    `,
    [spid, NEW_BOOKING_TYPES]
  );

  return { updated: (r.rowCount ?? 0) + (orphaned.rowCount ?? 0) };
}

/**
 * Clear unread payment-pending reminders when the booking is paid, cancelled, or no longer awaiting payment.
 */
export async function autoDismissStaleCustomerPaymentPendingReminders(customerId) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid < 1) return { updated: 0 };

  const r = await pool.query(
    `
    UPDATE in_app_notifications n
    SET read_at = COALESCE(n.read_at, NOW())
    FROM engagements e
    LEFT JOIN payments p ON p.engagement_id = e.engagement_id
    WHERE n.recipient_type = 'customer'
      AND n.recipient_id = $1
      AND n.read_at IS NULL
      AND n.type = $2
      AND n.engagement_id = e.engagement_id
      AND (
        p.payment_id IS NULL
        OR UPPER(COALESCE(p.status, '')) NOT IN ('PENDING', '')
        OR UPPER(COALESCE(e.task_status, '')) = 'CANCELLED'
        OR UPPER(COALESCE(e.engagement_status, '')) NOT IN ('PAYMENT_PENDING', 'CREATED', '')
      )
    `,
    [cid, InAppTypes.PAYMENT_PENDING_REMINDER]
  );

  const orphaned = await pool.query(
    `
    UPDATE in_app_notifications n
    SET read_at = COALESCE(n.read_at, NOW())
    WHERE n.recipient_type = 'customer'
      AND n.recipient_id = $1
      AND n.read_at IS NULL
      AND n.type = $2
      AND (
        n.engagement_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM engagements e WHERE e.engagement_id = n.engagement_id
        )
      )
    `,
    [cid, InAppTypes.PAYMENT_PENDING_REMINDER]
  );

  return { updated: (r.rowCount ?? 0) + (orphaned.rowCount ?? 0) };
}

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
