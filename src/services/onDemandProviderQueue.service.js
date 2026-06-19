import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { transitionEngagement } from "./engagementLifecycle.js";
import { findProviderBookedConflict, visitWindowFromEngagement } from "./providerAvailabilityOverlap.js";
import {
  createInAppNotification,
  dismissNewBookingInAppByEngagementId,
  dismissNewBookingInAppForProvider,
  emitBookingRequestClosed,
  InAppTypes,
} from "./inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const ON_DEMAND_QUEUE_MAX = 5;

const QUEUE_ACTIVE = "ACTIVE";
const QUEUE_WITHDRAWN = "WITHDRAWN";
const QUEUE_REJECTED = "REJECTED";
const QUEUE_REMOVED_CONFLICT = "REMOVED_CONFLICT";
const QUEUE_ADMIN_REMOVED = "ADMIN_REMOVED";
const QUEUE_PROMOTED = "PROMOTED";

const ON_DEMAND_ACCEPTABLE_PRIMARY_STATUSES = new Set([
  "OPEN_FOR_ACCEPTANCE",
  "UNASSIGNED",
  "CRM_ESCALATED",
]);

function isOnDemand(engagement) {
  return String(engagement?.booking_type || "").toUpperCase() === "ON_DEMAND";
}

function engagementLife(engagement) {
  return String(engagement?.engagement_status || "").toUpperCase();
}

function engagementTask(engagement) {
  return String(engagement?.task_status || "NOT_STARTED").toUpperCase();
}

function hasPrimaryAssigned(engagement) {
  const spid = engagement?.serviceproviderid;
  return spid != null && String(spid).trim() !== "";
}

export async function countActiveQueue(client, engagementId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM engagement_provider_queue
     WHERE engagement_id = $1 AND status = $2`,
    [engagementId, QUEUE_ACTIVE]
  );
  return Number(rows[0]?.c) || 0;
}

export async function fetchActiveQueueRows(client, engagementId) {
  const { rows } = await client.query(
    `SELECT q.*, sp.firstname, sp.lastname
     FROM engagement_provider_queue q
     JOIN serviceprovider sp ON sp.serviceproviderid = q.serviceproviderid
     WHERE q.engagement_id = $1 AND q.status = $2
     ORDER BY q.queue_position ASC`,
    [engagementId, QUEUE_ACTIVE]
  );
  return rows;
}

export async function fetchQueuesForEngagements(db, engagementIds) {
  const ids = [...new Set(engagementIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();

  const { rows } = await db.query(
    `SELECT q.engagement_id, q.queue_position, q.status, q.accepted_at,
            q.serviceproviderid, sp.firstname, sp.lastname
     FROM engagement_provider_queue q
     JOIN serviceprovider sp ON sp.serviceproviderid = q.serviceproviderid
     WHERE q.engagement_id = ANY($1::bigint[]) AND q.status = $2
     ORDER BY q.engagement_id, q.queue_position ASC`,
    [ids, QUEUE_ACTIVE]
  );

  const map = new Map();
  for (const row of rows) {
    const eid = Number(row.engagement_id);
    if (!map.has(eid)) map.set(eid, []);
    map.get(eid).push({
      queue_position: Number(row.queue_position),
      role: Number(row.queue_position) === 1 ? "primary" : "backup",
      serviceproviderid: Number(row.serviceproviderid),
      firstname: row.firstname,
      lastname: row.lastname,
      accepted_at: row.accepted_at,
    });
  }
  return map;
}

async function isProviderDeclined(client, engagementId, providerId) {
  const { rows } = await client.query(
    `SELECT 1 FROM engagement_provider_declines
     WHERE engagement_id = $1 AND serviceproviderid = $2`,
    [engagementId, providerId]
  );
  return rows.length > 0;
}

async function getProviderQueueRow(client, engagementId, providerId) {
  const { rows } = await client.query(
    `SELECT * FROM engagement_provider_queue
     WHERE engagement_id = $1 AND serviceproviderid = $2 AND status = $3`,
    [engagementId, providerId, QUEUE_ACTIVE]
  );
  return rows[0] || null;
}

async function bookPrimaryAvailability(client, engagement, providerId) {
  const visitWindow = visitWindowFromEngagement(engagement);
  if (!visitWindow) return;

  await client.query(`DELETE FROM provider_availability WHERE engagement_id = $1`, [
    engagement.engagement_id,
  ]);

  await client.query(
    `INSERT INTO provider_availability
     (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
     VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())
     ON CONFLICT DO NOTHING`,
    [
      providerId,
      engagement.engagement_id,
      visitWindow.startDate,
      visitWindow.startEpoch,
      visitWindow.endEpoch,
    ]
  );

  await client.query(
    `INSERT INTO service_days (engagement_id, service_date, status)
     VALUES ($1, $2::date, 'SCHEDULED')
     ON CONFLICT (engagement_id, service_date) DO NOTHING`,
    [engagement.engagement_id, visitWindow.startDate]
  );
}

async function clearEngagementAvailability(client, engagementId) {
  await client.query(`DELETE FROM provider_availability WHERE engagement_id = $1`, [engagementId]);
}

async function renumberActiveQueue(client, engagementId) {
  const rows = await fetchActiveQueueRows(client, engagementId);
  for (let i = 0; i < rows.length; i += 1) {
    const desired = i + 1;
    if (Number(rows[i].queue_position) === desired) continue;
    await client.query(
      `UPDATE engagement_provider_queue
       SET queue_position = $1, updated_at = NOW()
       WHERE queue_id = $2`,
      [desired, rows[i].queue_id]
    );
  }
}

async function markQueueStatus(client, queueId, status) {
  await client.query(
    `UPDATE engagement_provider_queue SET status = $1, updated_at = NOW() WHERE queue_id = $2`,
    [status, queueId]
  );
}

export function validateOnDemandQueueAccept(engagement, activeCount, _providerId, options = {}) {
  const { isDeclined = false, alreadyInQueue = false } = options;

  if (!isOnDemand(engagement)) {
    return { ok: false, status: 400, error: "Only ON_DEMAND bookings use the acceptance queue" };
  }

  const life = engagementLife(engagement);
  if (["CANCELLED", "EXPIRED", "COMPLETED"].includes(life)) {
    return { ok: false, status: 409, error: "Engagement no longer available" };
  }
  if (life === "IN_PROGRESS" || engagementTask(engagement) === "IN_PROGRESS") {
    return { ok: false, status: 409, error: "Engagement no longer available" };
  }

  if (isDeclined) {
    return { ok: false, status: 409, error: "You already declined this booking" };
  }
  if (alreadyInQueue) {
    return { ok: false, status: 409, error: "Already in queue for this booking" };
  }
  if (activeCount >= ON_DEMAND_QUEUE_MAX) {
    return { ok: false, status: 409, error: "Acceptance queue is full (max 5 providers)" };
  }

  if (activeCount === 0) {
    if (["PAYMENT_PENDING", "PAYMENT_FAILED"].includes(life)) {
      return { ok: false, status: 409, error: "Payment not completed" };
    }
    if (!ON_DEMAND_ACCEPTABLE_PRIMARY_STATUSES.has(life)) {
      return { ok: false, status: 409, error: "Engagement no longer available" };
    }
    if (String(engagement.assignment_status || "").toUpperCase() !== "UNASSIGNED") {
      return { ok: false, status: 409, error: "Engagement no longer available" };
    }
    if (hasPrimaryAssigned(engagement)) {
      return { ok: false, status: 409, error: "Already accepted" };
    }
    return { ok: true, role: "primary" };
  }

  if (!hasPrimaryAssigned(engagement)) {
    return { ok: false, status: 409, error: "Engagement no longer available" };
  }
  if (String(engagement.assignment_status || "").toUpperCase() !== "ASSIGNED") {
    return { ok: false, status: 409, error: "Engagement no longer available" };
  }

  return { ok: true, role: "backup", queuePosition: activeCount + 1 };
}

async function promoteNextPrimary(client, engagement, io = null) {
  const engagementId = engagement.engagement_id;
  await renumberActiveQueue(client, engagementId);
  const rows = await fetchActiveQueueRows(client, engagementId);
  const next = rows[0];

  if (!next) {
    await clearEngagementAvailability(client, engagementId);
    await client.query(
      `UPDATE engagements
       SET serviceproviderid = NULL, assignment_status = 'UNASSIGNED'
       WHERE engagement_id = $1`,
      [engagementId]
    );
    await transitionEngagement(client, {
      engagementId,
      newStatus: "OPEN_FOR_ACCEPTANCE",
      eventType: "PRIMARY_WITHDRAWN_NO_BACKUP",
      actorType: "SYSTEM",
      metadata: {},
    });
    const refreshed = (
      await client.query(`SELECT * FROM engagements WHERE engagement_id = $1`, [engagementId])
    ).rows[0];
    return { promoted: false, engagement: refreshed };
  }

  const newPrimaryId = Number(next.serviceproviderid);

  const conflictRow = await findProviderBookedConflict(
    client,
    newPrimaryId,
    engagement,
    engagementId
  );
  if (conflictRow) {
    await markQueueStatus(client, next.queue_id, QUEUE_REMOVED_CONFLICT);
    await renumberActiveQueue(client, engagementId);
    return promoteNextPrimary(client, engagement, io);
  }

  await removeProviderFromConflictingBackupQueues(client, newPrimaryId, engagementId);

  await client.query(
    `UPDATE engagements
     SET serviceproviderid = $1, assignment_status = 'ASSIGNED'
     WHERE engagement_id = $2`,
    [newPrimaryId, engagementId]
  );

  const refreshed = (
    await client.query(`SELECT * FROM engagements WHERE engagement_id = $1`, [engagementId])
  ).rows[0];

  await bookPrimaryAvailability(client, refreshed, newPrimaryId);

  await client.query(
    `INSERT INTO engagement_events
     (engagement_id, from_status, to_status, event_type, actor_type, actor_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      engagementId,
      engagement.engagement_status,
      refreshed.engagement_status || "ASSIGNED",
      "QUEUE_PRIMARY_PROMOTED",
      "SYSTEM",
      newPrimaryId,
      JSON.stringify({ previous_primary: engagement.serviceproviderid }),
    ]
  );

  const socketServer = io ?? getSocketServer();
  if (socketServer && refreshed.customerid) {
    try {
      await createInAppNotification({
        io: socketServer,
        recipientType: "customer",
        recipientId: refreshed.customerid,
        type: InAppTypes.BOOKING_ACCEPTED,
        title: "Your provider was updated",
        body: `Engagement #${engagementId} is confirmed with your backup provider.`,
        engagementId: Number(engagementId),
        metadata: { service_type: refreshed.service_type, queue_promoted: true },
      });
    } catch (err) {
      console.error("in-app (queue promote) failed", err);
    }
  }

  return { promoted: true, engagement: refreshed, newPrimaryId };
}

export async function acceptOnDemandIntoQueue(client, engagement, providerId) {
  if (!isOnDemand(engagement)) {
    const err = new Error("Only ON_DEMAND bookings use the acceptance queue");
    err.statusCode = 400;
    throw err;
  }

  const engagementId = engagement.engagement_id;
  const activeCount = await countActiveQueue(client, engagementId);
  const declined = await isProviderDeclined(client, engagementId, providerId);
  const inQueue = await getProviderQueueRow(client, engagementId, providerId);

  const check = validateOnDemandQueueAccept(engagement, activeCount, providerId, {
    isDeclined: declined,
    alreadyInQueue: !!inQueue,
  });
  if (!check.ok) {
    const err = new Error(check.error);
    err.statusCode = check.status;
    throw err;
  }

  if (!engagement.start_epoch) {
    const err = new Error("Engagement timing missing");
    err.statusCode = 400;
    throw err;
  }

  const conflictRow = await findProviderBookedConflict(
    client,
    providerId,
    engagement,
    engagementId
  );
  if (conflictRow) {
    const err = new Error(
      `Provider has time conflict: engagement #${conflictRow.engagement_id} on ${conflictRow.date}`
    );
    err.statusCode = 409;
    err.detail = err.message;
    throw err;
  }

  if (check.role === "primary") {
    await removeProviderFromConflictingBackupQueues(client, providerId, engagementId);

    await client.query(
      `UPDATE engagements
       SET serviceproviderid = $1, assignment_status = 'ASSIGNED'
       WHERE engagement_id = $2`,
      [providerId, engagementId]
    );

    await transitionEngagement(client, {
      engagementId,
      newStatus: "ASSIGNED",
      eventType: "PROVIDER_ACCEPTED",
      actorType: "PROVIDER",
      actorId: providerId,
    });

    await client.query(
      `INSERT INTO engagement_provider_queue
       (engagement_id, serviceproviderid, queue_position, status)
       VALUES ($1,$2,1,$3)`,
      [engagementId, providerId, QUEUE_ACTIVE]
    );

    const updated = (
      await client.query(`SELECT * FROM engagements WHERE engagement_id = $1`, [engagementId])
    ).rows[0];

    return { role: "primary", queuePosition: 1, engagement: updated };
  }

  const position = check.queuePosition;
  await client.query(
    `INSERT INTO engagement_provider_queue
     (engagement_id, serviceproviderid, queue_position, status)
     VALUES ($1,$2,$3,$4)`,
    [engagementId, providerId, position, QUEUE_ACTIVE]
  );

  return { role: "backup", queuePosition: position, engagement };
}

export async function declineOnDemandOffer(client, engagementId, providerId) {
  await client.query(
    `INSERT INTO engagement_provider_declines (engagement_id, serviceproviderid)
     VALUES ($1,$2)
     ON CONFLICT (engagement_id, serviceproviderid) DO NOTHING`,
    [engagementId, providerId]
  );

  const row = await getProviderQueueRow(client, engagementId, providerId);
  if (row) {
    await markQueueStatus(client, row.queue_id, QUEUE_REJECTED);
    await renumberActiveQueue(client, engagementId);
  }
}

export async function withdrawFromOnDemandQueue(client, engagement, providerId, { io = null } = {}) {
  if (!isOnDemand(engagement)) {
    const err = new Error("Only ON_DEMAND bookings support provider withdraw");
    err.statusCode = 400;
    throw err;
  }

  const life = engagementLife(engagement);
  const task = engagementTask(engagement);
  if (life === "IN_PROGRESS" || task === "IN_PROGRESS" || task === "STARTED") {
    const err = new Error("Cannot withdraw after service has started");
    err.statusCode = 400;
    throw err;
  }

  const row = await getProviderQueueRow(client, engagement.engagement_id, providerId);
  if (!row) {
    const err = new Error("Provider is not in the acceptance queue for this booking");
    err.statusCode = 404;
    throw err;
  }

  const position = Number(row.queue_position);
  if (position === 1) {
    if (Number(engagement.serviceproviderid) !== Number(providerId)) {
      const err = new Error("Provider is not the primary for this booking");
      err.statusCode = 409;
      throw err;
    }

    await markQueueStatus(client, row.queue_id, QUEUE_WITHDRAWN);
    await clearEngagementAvailability(client, engagement.engagement_id);
    await renumberActiveQueue(client, engagement.engagement_id);

    const result = await promoteNextPrimary(client, engagement, io);
    return {
      role: "primary",
      withdrawn: true,
      promoted: result.promoted,
      engagement: result.engagement,
    };
  }

  await markQueueStatus(client, row.queue_id, QUEUE_WITHDRAWN);
  await renumberActiveQueue(client, engagement.engagement_id);

  return { role: "backup", withdrawn: true, promoted: false, engagement };
}

export async function removeProviderFromConflictingBackupQueues(
  client,
  providerId,
  assignedEngagementId
) {
  const { rows } = await client.query(
    `SELECT queue_id, engagement_id
     FROM engagement_provider_queue
     WHERE serviceproviderid = $1
       AND status = $2
       AND queue_position > 1
       AND engagement_id <> $3`,
    [providerId, QUEUE_ACTIVE, assignedEngagementId]
  );

  for (const row of rows) {
    await markQueueStatus(client, row.queue_id, QUEUE_REMOVED_CONFLICT);
    await renumberActiveQueue(client, row.engagement_id);
  }

  return rows.length;
}

export async function adminSetProviderQueue(
  client,
  engagementId,
  providerIds,
  { adminUserId = null } = {}
) {
  const unique = [];
  const seen = new Set();
  for (const raw of providerIds || []) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length > ON_DEMAND_QUEUE_MAX) break;
  }

  if (!unique.length) {
    const err = new Error("At least one provider id is required");
    err.statusCode = 400;
    throw err;
  }

  const engRes = await client.query(
    `SELECT * FROM engagements WHERE engagement_id = $1 FOR UPDATE`,
    [engagementId]
  );
  if (!engRes.rows.length) {
    const err = new Error("Engagement not found");
    err.statusCode = 404;
    throw err;
  }
  const engagement = engRes.rows[0];
  if (!isOnDemand(engagement)) {
    const err = new Error("Provider queue is only for ON_DEMAND engagements");
    err.statusCode = 400;
    throw err;
  }

  await client.query(
    `UPDATE engagement_provider_queue
     SET status = $1, updated_at = NOW()
     WHERE engagement_id = $2 AND status = $3`,
    [QUEUE_ADMIN_REMOVED, engagementId, QUEUE_ACTIVE]
  );

  await clearEngagementAvailability(client, engagementId);

  for (let i = 0; i < unique.length; i += 1) {
    const spid = unique[i];
    const position = i + 1;
    if (position === 1) {
      const conflict = await findProviderBookedConflict(client, spid, engagement, engagementId);
      if (conflict) {
        const err = new Error(
          `Primary provider conflicts with engagement #${conflict.engagement_id} on ${conflict.date}`
        );
        err.statusCode = 409;
        throw err;
      }
    }
    await client.query(
      `INSERT INTO engagement_provider_queue
       (engagement_id, serviceproviderid, queue_position, status)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (engagement_id, serviceproviderid)
       DO UPDATE SET queue_position = EXCLUDED.queue_position, status = EXCLUDED.status, updated_at = NOW()`,
      [engagementId, spid, position, QUEUE_ACTIVE]
    );
  }

  const primaryId = unique[0];
  await removeProviderFromConflictingBackupQueues(client, primaryId, engagementId);

  await client.query(
    `UPDATE engagements
     SET serviceproviderid = $1, assignment_status = 'ASSIGNED'
     WHERE engagement_id = $2`,
    [primaryId, engagementId]
  );

  const life = engagementLife(engagement);
  if (!["ASSIGNED", "IN_PROGRESS", "COMPLETED"].includes(life)) {
    await transitionEngagement(client, {
      engagementId,
      newStatus: "ASSIGNED",
      eventType: "ADMIN_QUEUE_SET",
      actorType: "ADMIN",
      actorId: adminUserId,
      metadata: { providerIds: unique },
    });
  } else {
    const refreshed = (
      await client.query(`SELECT * FROM engagements WHERE engagement_id = $1`, [engagementId])
    ).rows[0];
    await bookPrimaryAvailability(client, refreshed, primaryId);
    await client.query(
      `INSERT INTO engagement_events
       (engagement_id, from_status, to_status, event_type, actor_type, actor_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        engagementId,
        life,
        life,
        "ADMIN_QUEUE_SET",
        "ADMIN",
        adminUserId,
        JSON.stringify({ providerIds: unique }),
      ]
    );
  }

  const updated = (
    await client.query(`SELECT * FROM engagements WHERE engagement_id = $1`, [engagementId])
  ).rows[0];

  return {
    engagement: updated,
    provider_queue: await fetchActiveQueueRows(client, engagementId),
  };
}

export async function postAcceptNotifications(
  engagementId,
  engagement,
  providerId,
  role,
  io,
  { queueCountAfterAccept = 1 } = {}
) {
  const queueFull = queueCountAfterAccept >= ON_DEMAND_QUEUE_MAX;

  try {
    await dismissNewBookingInAppForProvider(engagementId, providerId);
  } catch (eDismiss) {
    console.error("dismiss provider new-booking in-app failed", eDismiss);
  }

  if (role === "primary") {
    try {
      await createInAppNotification({
        io,
        recipientType: "customer",
        recipientId: engagement.customerid,
        type: InAppTypes.BOOKING_ACCEPTED,
        title: "A provider accepted your booking",
        body: `Engagement #${engagementId} is confirmed for ${engagement.service_type || "your service"}.`,
        engagementId: Number(engagementId),
        metadata: { service_type: engagement.service_type },
      });
    } catch (eNotif) {
      console.error("in-app (accept) failed", eNotif);
    }

    if (io && engagement.customerid) {
      io.to(`customer_${engagement.customerid}`).emit("engagement-accepted", {
        engagement_id: engagementId,
        serviceproviderid: Number(providerId),
      });
    }
  }

  if (queueFull) {
    try {
      await dismissNewBookingInAppByEngagementId(engagementId);
    } catch (eDismissAll) {
      console.error("dismiss all new-booking in-app failed", eDismissAll);
    }
    emitBookingRequestClosed(io, engagementId, queueFull ? "queue_full" : "accepted");
  }
}

function canProviderWithdrawOnDemand(engagement, queuePosition) {
  if (queuePosition == null) return false;
  if (String(engagement?.booking_type || "").toUpperCase() !== "ON_DEMAND") return false;
  const life = String(engagement?.engagement_status || "").toUpperCase();
  const task = String(engagement?.task_status || "NOT_STARTED").toUpperCase();
  if (life === "IN_PROGRESS" || task === "IN_PROGRESS" || task === "STARTED") return false;
  return true;
}

export async function fetchQueuePositionMap(db, providerId, engagementIds = []) {
  const ids = [...new Set(engagementIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT engagement_id, queue_position
     FROM engagement_provider_queue
     WHERE serviceproviderid = $1 AND status = 'ACTIVE' AND engagement_id = ANY($2::bigint[])`,
    [providerId, ids]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(Number(row.engagement_id), Number(row.queue_position));
  }
  return map;
}

/**
 * On-demand engagements where this provider is an active backup (queue position > 1).
 */
export async function fetchStandbyEngagementRowsForProvider(db, providerId, monthFilter = null) {
  const params = [providerId];
  let monthClause = "";
  if (monthFilter) {
    const monthStart = dayjs.tz(`${monthFilter}-01`, "YYYY-MM-DD", "Asia/Kolkata").startOf("month");
    const monthEnd = monthStart.endOf("month");
    monthClause = ` AND e.start_date <= $2::date AND e.end_date >= $3::date`;
    params.push(monthEnd.format("YYYY-MM-DD"), monthStart.format("YYYY-MM-DD"));
  }

  const { rows } = await db.query(
    `
    SELECT
      e.engagement_id,
      e.customerid,
      e.serviceproviderid,
      e.start_date,
      e.end_date,
      e.start_epoch,
      e.end_epoch,
      e.responsibilities,
      e.booking_type,
      e.service_type,
      e.task_status,
      e.assignment_status,
      e.engagement_status,
      e.base_amount,
      e.address,
      e.duration_minutes,
      e.created_at,
      e.vacation_start_date,
      e.vacation_end_date,
      e.leave_days,
      c.firstname,
      c.lastname,
      c.mobileno,
      q.queue_id,
      q.queue_position,
      true AS is_queue_standby
    FROM engagement_provider_queue q
    INNER JOIN engagements e ON e.engagement_id = q.engagement_id
    INNER JOIN customer c ON c.customerid = e.customerid
    WHERE q.serviceproviderid = $1
      AND q.status = 'ACTIVE'
      AND q.queue_position > 1
      AND UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
      AND UPPER(COALESCE(e.engagement_status, '')) NOT IN ('CANCELLED', 'EXPIRED', 'COMPLETED')
      AND UPPER(COALESCE(e.task_status, '')) NOT IN ('CANCELLED', 'COMPLETED')
      ${monthClause}
    ORDER BY e.start_epoch ASC NULLS LAST, e.engagement_id ASC
    `,
    params
  );
  return rows;
}

/**
 * Calendar rows for backup queue slots (no provider_availability BOOKED row).
 */
export async function fetchStandbyCalendarEntriesForProvider(db, providerId, month) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return [];
  const monthStart = dayjs.tz(`${month}-01`, "YYYY-MM-DD", "Asia/Kolkata").startOf("month");
  const monthEnd = monthStart.endOf("month");

  const { rows } = await db.query(
    `
    SELECT
      q.queue_id,
      q.engagement_id,
      q.queue_position,
      e.start_epoch,
      e.end_epoch,
      e.start_date,
      e.duration_minutes
    FROM engagement_provider_queue q
    INNER JOIN engagements e ON e.engagement_id = q.engagement_id
    WHERE q.serviceproviderid = $1
      AND q.status = 'ACTIVE'
      AND q.queue_position > 1
      AND UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
      AND UPPER(COALESCE(e.engagement_status, '')) NOT IN ('CANCELLED', 'EXPIRED', 'COMPLETED')
      AND e.start_date <= $3::date
      AND COALESCE(e.end_date, e.start_date) >= $2::date
    ORDER BY e.start_epoch ASC NULLS LAST
    `,
    [providerId, monthStart.format("YYYY-MM-DD"), monthEnd.format("YYYY-MM-DD")]
  );

  return rows.map((row) => {
    const startEp = Number(row.start_epoch);
    const durationMin = Number(row.duration_minutes) || 60;
    const endEp =
      Number.isFinite(Number(row.end_epoch)) && Number(row.end_epoch) > startEp
        ? Number(row.end_epoch)
        : startEp + durationMin * 60;
    const dateYmd = row.start_date
      ? dayjs(row.start_date).format("YYYY-MM-DD")
      : dayjs.unix(startEp).tz("Asia/Kolkata").format("YYYY-MM-DD");

    return {
      id: -Number(row.queue_id),
      serviceproviderid: Number(providerId),
      engagement_id: Number(row.engagement_id),
      date: dateYmd,
      slot_start_epoch: startEp,
      slot_end_epoch: endEp,
      status: "QUEUE_STANDBY",
      queue_position: Number(row.queue_position),
      start_epoch: startEp,
      end_epoch: endEp,
      start_time: dayjs.unix(startEp).tz("Asia/Kolkata").format("HH:mm"),
      end_time: dayjs.unix(endEp).tz("Asia/Kolkata").format("HH:mm"),
    };
  });
}

export { canProviderWithdrawOnDemand };
