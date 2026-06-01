import pool from "../config/db.js";

/**
 * Resolve a booking by canonical engagements.engagement_id.
 * @param {number|string} engagementId
 */
export async function resolveEngagementRef(engagementId) {
  const id = Number(engagementId);
  if (!Number.isFinite(id) || id < 1) return null;

  const { rows } = await pool.query(
    `
    SELECT engagement_id, customerid, serviceproviderid, booking_type, service_type,
           task_status, assignment_status, start_date, end_date
    FROM engagements
    WHERE engagement_id = $1
    `,
    [id]
  );
  if (!rows.length) return null;

  const r = rows[0];
  return {
    engagementId: Number(r.engagement_id),
    customerid: Number(r.customerid),
    serviceproviderid: r.serviceproviderid != null ? Number(r.serviceproviderid) : null,
    booking_type: r.booking_type,
    service_type: r.service_type,
    task_status: r.task_status,
    assignment_status: r.assignment_status,
    start_date: r.start_date,
    end_date: r.end_date,
  };
}
