/** Recorded on engagement_events and in-app notification metadata. */
export const ON_DEMAND_AUTO_CANCEL_REASON =
  "No Provider Available / Provider Not Assigned";

export const ON_DEMAND_AUTO_CANCEL_EVENT = "ON_DEMAND_AUTO_CANCELLED_NO_PROVIDER";

const OPEN_ENGAGEMENT_STATUSES = new Set([
  "OPEN_FOR_ACCEPTANCE",
  "UNASSIGNED",
  "CRM_ESCALATED",
]);

const TERMINAL_TASK_STATUSES = new Set(["CANCELLED", "COMPLETED", "IN_PROGRESS"]);

/**
 * True when a paid on-demand booking passed its start time with no provider assigned.
 */
export function isEligibleForOnDemandAutoCancel(engagement, payment, nowEpoch) {
  if (!engagement || !payment) return false;
  if (String(engagement.booking_type || "").toUpperCase() !== "ON_DEMAND") {
    return false;
  }
  if (String(payment.status || "").toUpperCase() !== "SUCCESS") {
    return false;
  }
  if (engagement.serviceproviderid != null) {
    return false;
  }

  const assignment = String(engagement.assignment_status || "").toUpperCase();
  if (assignment && assignment !== "UNASSIGNED") {
    return false;
  }

  const life = String(engagement.engagement_status || "").toUpperCase();
  if (!OPEN_ENGAGEMENT_STATUSES.has(life)) {
    return false;
  }

  const task = String(engagement.task_status || "").toUpperCase();
  if (TERMINAL_TASK_STATUSES.has(task)) {
    return false;
  }

  const startEp = Number(engagement.start_epoch);
  const now = Number(nowEpoch);
  if (!Number.isFinite(startEp) || startEp <= 0) return false;
  if (!Number.isFinite(now) || now < startEp) return false;

  return true;
}
