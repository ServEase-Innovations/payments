/**
 * Derives a meaningful task / work status for customer & admin UIs.
 * The DB column `engagements.task_status` is not always updated on lifecycle events;
 * this module mirrors engagement phase, date bucket, and today's service_day.
 */

const WORK_PHASE = {
  UPCOMING: "upcoming", // before service window
  ACTIVE: "active", // in window; service may be scheduled, in progress, or done for the day
  PAST: "past", // service window ended
};

/**
 * @param {object} e - engagement row
 * @param {string} bucket - "upcoming" | "ongoing" | "past" (as used in customer list)
 * @param {object|null} [todayServiceRow] - from service_days for service_date = today
 * @returns {{ task_status: string, work_summary: object }}
 */
function isOnDemandEngagement(e) {
  return String(e.booking_type || "").toUpperCase() === "ON_DEMAND";
}

function isSingleDayEngagement(e) {
  const start = String(e.start_date ?? "").slice(0, 10);
  const end = String(e.end_date ?? e.start_date ?? "").slice(0, 10);
  return start && end && start === end;
}

export function deriveTaskStatusForCustomer(e, bucket, todayServiceRow) {
  const life = (e.engagement_status && String(e.engagement_status).toUpperCase()) || "";
  const storedTask = (e.task_status && String(e.task_status).toUpperCase()) || "";

  if (life === "CANCELLED" || storedTask === "CANCELLED") {
    return {
      task_status: "CANCELLED",
      work_summary: {
        phase:
          bucket === "past"
            ? WORK_PHASE.PAST
            : bucket === "upcoming"
              ? WORK_PHASE.UPCOMING
              : WORK_PHASE.ACTIVE,
        engagement_status: e.engagement_status ?? null,
        today_visit: null,
        label: "Cancelled",
      },
    };
  }

  const dayStatus = todayServiceRow
    ? String(todayServiceRow.status || "").toUpperCase()
    : null;

  /** Default work_summary; refined below */
  const work_summary = {
    phase:
      bucket === "past"
        ? WORK_PHASE.PAST
        : bucket === "upcoming"
          ? WORK_PHASE.UPCOMING
          : WORK_PHASE.ACTIVE,
    engagement_status: e.engagement_status ?? null,
    today_visit: todayServiceRow
      ? {
          service_day_id: todayServiceRow.service_day_id,
          status: todayServiceRow.status,
          started_at: todayServiceRow.started_at ?? null,
          completed_at: todayServiceRow.completed_at ?? null,
        }
      : null,
    label: "",
  };

  // Today's visit state overrides calendar bucket (e.g. provider started before slot time)
  if (dayStatus === "IN_PROGRESS" || dayStatus === "STARTED") {
    work_summary.phase = WORK_PHASE.ACTIVE;
    work_summary.label = "Visit in progress";
    return { task_status: "IN_PROGRESS", work_summary };
  }
  if (
    dayStatus === "COMPLETED" ||
    dayStatus === "DONE" ||
    dayStatus === "SKIPPED"
  ) {
    work_summary.phase = WORK_PHASE.ACTIVE;
    work_summary.label = "Today's visit completed";
    if (dayStatus === "SKIPPED") {
      work_summary.label = "Today's visit skipped / not required";
    }
    if (life === "COMPLETED" || isOnDemandEngagement(e) || isSingleDayEngagement(e)) {
      work_summary.label = "Service completed";
      return { task_status: "COMPLETED", work_summary };
    }
    return { task_status: "IN_PROGRESS", work_summary };
  }
  if (dayStatus === "SCHEDULED" || dayStatus === "PENDING") {
    work_summary.phase = WORK_PHASE.ACTIVE;
    work_summary.label = "Today's visit not started";
    // Fall through to bucket rules unless same-day visit is the only activity
  }

  // --- PAST: booking over → treat work as done for this engagement
  if (bucket === "past") {
    work_summary.label = "Service period ended";
    if (life === "CANCELLED" || (e.assignment_status || "").toUpperCase() === "CANCELLED") {
      work_summary.label = "Service period ended (cancelled or not completed)";
    }
    return { task_status: "COMPLETED", work_summary };
  }

  // --- UPCOMING: not started
  if (bucket === "upcoming") {
    work_summary.label = "Scheduled";
    if (["UNASSIGNED", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(life)) {
      work_summary.label = "Awaiting assignment or payment";
    }
    return { task_status: "NOT_STARTED", work_summary };
  }

  // --- ONGOING (no today row, or scheduled for later today)
  if (dayStatus === "SCHEDULED" || dayStatus === "PENDING") {
    return { task_status: "NOT_STARTED", work_summary };
  }

  // No row for today but period is current — infer from engagement lifecycle
  if (life === "COMPLETED") {
    work_summary.label = "Completed";
    return { task_status: "COMPLETED", work_summary };
  }
  if (life === "IN_PROGRESS") {
    work_summary.label = "Active booking";
    return { task_status: "IN_PROGRESS", work_summary };
  }
  if (e.serviceproviderid) {
    work_summary.label = "Active within service period";
    return { task_status: "IN_PROGRESS", work_summary };
  }
  work_summary.label = "Awaiting provider";
  return { task_status: "NOT_STARTED", work_summary };
}

/**
 * Provider dashboard: prefer today's service_days.status over stale engagements.task_status.
 * @param {object} e - engagement row (task_status, booking_type, engagement_status, start_date, end_date)
 * @param {object|null} [todayServiceRow] - { status } from service_days for IST today
 */
export function deriveTaskStatusForProvider(e, todayServiceRow) {
  const dayStatus = todayServiceRow
    ? String(todayServiceRow.status || "").toUpperCase()
    : "";

  if (dayStatus === "IN_PROGRESS" || dayStatus === "STARTED") {
    return "IN_PROGRESS";
  }
  if (dayStatus === "COMPLETED" || dayStatus === "DONE") {
    return "COMPLETED";
  }

  const stored = String(e.task_status || "").toUpperCase();
  if (stored === "STARTED") return "IN_PROGRESS";
  if (stored === "IN_PROGRESS" || stored === "COMPLETED" || stored === "CANCELLED") {
    return stored;
  }

  const life = String(e.engagement_status || "").toUpperCase();
  if (life === "IN_PROGRESS") return "IN_PROGRESS";
  if (life === "COMPLETED") return "COMPLETED";
  if (life === "CANCELLED") return "CANCELLED";

  return "NOT_STARTED";
}
