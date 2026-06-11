import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function epochInIST(dateStr, timeStr) {
  return dayjs
    .tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata")
    .unix();
}

function calendarYmdKolkata(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

function isDateInEngagementVacation(dateYmd, vacationStart, vacationEnd) {
  if (vacationStart == null || vacationEnd == null) return false;
  const d = calendarYmdKolkata(dateYmd);
  const a = calendarYmdKolkata(vacationStart);
  const b = calendarYmdKolkata(vacationEnd);
  if (!d || !a || !b) return false;
  return d >= a && d <= b;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

export function rolesMatchForSearch(serviceType, roleNorm) {
  const service = String(serviceType ?? "").trim().toLowerCase();
  const role = String(roleNorm ?? "").trim().toLowerCase();
  if (!service || !role) return true;
  if (service === role) return true;
  if (service.includes("cook") && role.includes("cook")) return true;
  if (service.includes("maid") && role.includes("maid")) return true;
  if (service.includes("nanny") && role.includes("nanny")) return true;
  return false;
}

export function isActiveBlockingEngagement(prev) {
  if (!prev || prev.active === false) return false;
  const life = String(
    prev.engagementStatus ?? prev.engagement_status ?? ""
  ).toUpperCase();
  const task = String(
    prev.taskStatus ?? prev.task_status ?? "NOT_STARTED"
  ).toUpperCase();
  if (["CANCELLED", "COMPLETED", "CLOSED", "EXPIRED"].includes(life)) {
    return false;
  }
  if (["CANCELLED", "COMPLETED"].includes(task)) return false;
  return true;
}

function engagementOverlapsSearchWindow(prev, rangeStartStr, rangeEndStr) {
  if (!prev) return false;
  const startRaw = prev.startDate ?? prev.start_date;
  const endRaw = prev.endDate ?? prev.end_date;
  const engStart = dayjs(startRaw).tz("Asia/Kolkata").startOf("day");
  const engEnd = dayjs(endRaw).tz("Asia/Kolkata").startOf("day");
  const reqStart = dayjs.tz(rangeStartStr, "YYYY-MM-DD", "Asia/Kolkata").startOf(
    "day"
  );
  const reqEnd = dayjs.tz(rangeEndStr, "YYYY-MM-DD", "Asia/Kolkata").startOf(
    "day"
  );
  return (
    !engEnd.isBefore(reqStart, "day") && !engStart.isAfter(reqEnd, "day")
  );
}

/**
 * True when the customer's existing engagement with this provider would block
 * the requested visit window — same calendar day (non-vacation) and overlapping
 * wall-clock slot. Date-range overlap alone (e.g. monthly contract vs 08:00
 * short-term while monthly visits are at 14:00) is not a conflict.
 */
export function customerHasSchedulableConflict(
  prev,
  rangeStartStr,
  rangeEndStr,
  preferredTime,
  durationSec,
  roleNorm
) {
  if (!isActiveBlockingEngagement(prev)) return false;
  if (!rolesMatchForSearch(prev.serviceType ?? prev.service_type, roleNorm)) {
    return false;
  }
  if (!engagementOverlapsSearchWindow(prev, rangeStartStr, rangeEndStr)) {
    return false;
  }

  const startEp = Number(prev.startEpoch ?? prev.start_epoch);
  let visitTimeStr;
  if (Number.isFinite(startEp)) {
    visitTimeStr = dayjs.unix(startEp).tz("Asia/Kolkata").format("HH:mm");
  } else {
    const startRaw = prev.startDate ?? prev.start_date;
    if (startRaw != null) {
      visitTimeStr = dayjs(startRaw).tz("Asia/Kolkata").format("HH:mm");
    } else {
      return true;
    }
  }

  let visitDurSec = durationSec;
  const dm = prev.durationMinutes ?? prev.duration_minutes;
  if (dm != null && dm >= 1 && dm <= 24 * 60) {
    visitDurSec = dm * 60;
  }

  const rangeStart = dayjs
    .tz(rangeStartStr, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day");
  const rangeEnd = dayjs.tz(rangeEndStr, "YYYY-MM-DD", "Asia/Kolkata").startOf(
    "day"
  );
  const engStart = dayjs(prev.startDate ?? prev.start_date)
    .tz("Asia/Kolkata")
    .startOf("day");
  const engEnd = dayjs(prev.endDate ?? prev.end_date)
    .tz("Asia/Kolkata")
    .startOf("day");

  const from = engStart.isAfter(rangeStart) ? engStart : rangeStart;
  const to = engEnd.isBefore(rangeEnd) ? engEnd : rangeEnd;

  const vacationStart = prev.vacationStartDate ?? prev.vacation_start_date;
  const vacationEnd = prev.vacationEndDate ?? prev.vacation_end_date;

  for (let c = from.clone(); !c.isAfter(to, "day"); c = c.add(1, "day")) {
    const dateStr = c.format("YYYY-MM-DD");
    if (isDateInEngagementVacation(dateStr, vacationStart, vacationEnd)) {
      continue;
    }
    const prefStart = epochInIST(dateStr, preferredTime);
    const prefEnd = prefStart + durationSec;
    const visitStart = epochInIST(dateStr, visitTimeStr);
    const visitEnd = visitStart + visitDurSec;
    if (overlaps(prefStart, prefEnd, visitStart, visitEnd)) {
      return true;
    }
  }
  return false;
}
