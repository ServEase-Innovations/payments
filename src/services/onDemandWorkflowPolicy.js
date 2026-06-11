/** Minutes after payment before unassigned on-demand bookings escalate to CRM. */
export const ON_DEMAND_ACCEPTANCE_WINDOW_MINUTES_DEFAULT = 30;

/** Minutes before scheduled start to escalate unassigned bookings to admin/CRM. */
export const ON_DEMAND_CRM_ESCALATION_MINUTES_BEFORE_START_DEFAULT = 20;

/** Minutes before scheduled start to notify customer that assignment is still pending. */
export const ON_DEMAND_CUSTOMER_OUTREACH_MINUTES_BEFORE_START_DEFAULT = 120;

export const ON_DEMAND_CRM_ESCALATION_EVENT = "ON_DEMAND_CRM_ESCALATED";
export const ON_DEMAND_CUSTOMER_OUTREACH_EVENT = "ON_DEMAND_CUSTOMER_OUTREACH";

const UNASSIGNED_ON_DEMAND_STATUSES = new Set([
  "OPEN_FOR_ACCEPTANCE",
  "UNASSIGNED",
  "CRM_ESCALATED",
  "",
]);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function getOnDemandAcceptanceWindowMinutes() {
  return clampInt(
    process.env.ON_DEMAND_ACCEPTANCE_WINDOW_MINUTES,
    5,
    24 * 60,
    ON_DEMAND_ACCEPTANCE_WINDOW_MINUTES_DEFAULT
  );
}

export function getOnDemandCrmEscalationMinutesBeforeStart() {
  return clampInt(
    process.env.ON_DEMAND_CRM_ESCALATION_MINUTES_BEFORE_START,
    5,
    24 * 60,
    ON_DEMAND_CRM_ESCALATION_MINUTES_BEFORE_START_DEFAULT
  );
}

export function getOnDemandCustomerOutreachMinutesBeforeStart() {
  return clampInt(
    process.env.ON_DEMAND_CUSTOMER_OUTREACH_MINUTES_BEFORE_START,
    15,
    24 * 60,
    ON_DEMAND_CUSTOMER_OUTREACH_MINUTES_BEFORE_START_DEFAULT
  );
}

/** Why an unassigned on-demand booking is ready for admin escalation. */
export function resolveOnDemandCrmEscalationReason(
  engagement,
  paymentCompletedAt,
  nowEpoch
) {
  const startEp = Number(engagement?.start_epoch);
  const now = Number(nowEpoch);
  if (!Number.isFinite(startEp) || !Number.isFinite(now)) return null;

  const paidAt = paymentCompletedAt ? new Date(paymentCompletedAt).getTime() : NaN;
  const acceptanceWindowElapsed =
    Number.isFinite(paidAt) &&
    now * 1000 >= paidAt + getOnDemandAcceptanceWindowMinutes() * 60 * 1000;
  const startLeadSec = getOnDemandCrmEscalationMinutesBeforeStart() * 60;
  const withinStartLead = now >= startEp - startLeadSec;

  if (acceptanceWindowElapsed && withinStartLead) return "ACCEPTANCE_WINDOW_AND_START_LEAD";
  if (acceptanceWindowElapsed) return "ACCEPTANCE_WINDOW_ELAPSED";
  if (withinStartLead) return "START_TIME_APPROACHING";
  return null;
}

export function isUnassignedOnDemandEngagement(engagement) {
  if (!engagement) return false;
  if (String(engagement.booking_type || "").toUpperCase() !== "ON_DEMAND") return false;
  if (engagement.serviceproviderid != null && String(engagement.serviceproviderid).trim() !== "") {
    return false;
  }
  if (String(engagement.assignment_status || "").toUpperCase() === "ASSIGNED") return false;
  const life = String(engagement.engagement_status || "").toUpperCase();
  if (!UNASSIGNED_ON_DEMAND_STATUSES.has(life)) return false;
  const task = String(engagement.task_status || "NOT_STARTED").toUpperCase();
  if (["CANCELLED", "COMPLETED", "IN_PROGRESS"].includes(task)) return false;
  return true;
}

export function isEligibleForOnDemandCrmEscalation(
  engagement,
  payment,
  paymentCompletedAt,
  nowEpoch
) {
  if (!isUnassignedOnDemandEngagement(engagement)) return false;
  if (String(payment?.status || "").toUpperCase() !== "SUCCESS") return false;

  const startEp = Number(engagement.start_epoch);
  const now = Number(nowEpoch);
  if (!Number.isFinite(startEp) || startEp <= 0 || !Number.isFinite(now)) return false;
  if (now >= startEp) return false;

  const paidAt = paymentCompletedAt ? new Date(paymentCompletedAt).getTime() : NaN;
  if (!Number.isFinite(paidAt)) return false;

  return (
    resolveOnDemandCrmEscalationReason(engagement, paymentCompletedAt, nowEpoch) != null
  );
}

export function isEligibleForOnDemandCustomerOutreach(
  engagement,
  payment,
  nowEpoch,
  { crmEscalated = false } = {}
) {
  if (!crmEscalated) return false;
  if (!isUnassignedOnDemandEngagement(engagement)) return false;
  if (String(payment?.status || "").toUpperCase() !== "SUCCESS") return false;

  const startEp = Number(engagement.start_epoch);
  const now = Number(nowEpoch);
  if (!Number.isFinite(startEp) || startEp <= 0 || !Number.isFinite(now)) return false;
  if (now >= startEp) return false;

  const outreachLeadSec = getOnDemandCustomerOutreachMinutesBeforeStart() * 60;
  return now >= startEp - outreachLeadSec;
}
