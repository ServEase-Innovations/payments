import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

/** @returns {Record<string, unknown>} */
export function parseNotificationMetadata(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed }
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ...raw };
  }
  return {};
}

/**
 * Standard booking fields for in-app notification metadata (customer + provider UIs).
 * @param {object} engagement
 * @param {Record<string, unknown>} [extras]
 */
export function buildBookingNotificationMetadata(engagement, extras = {}) {
  const startTimeLabel = engagement.start_epoch
    ? dayjs
        .unix(Number(engagement.start_epoch))
        .tz("Asia/Kolkata")
        .format("D MMM YYYY, h:mm a")
    : engagement.start_date
      ? String(engagement.start_date)
      : "";

  const addressLine = engagement.address ? String(engagement.address).trim() : "";

  return {
    service_type: engagement.service_type ?? null,
    booking_type: engagement.booking_type ?? null,
    start_date: engagement.start_date ?? null,
    end_date: engagement.end_date ?? null,
    start_epoch:
      engagement.start_epoch != null ? Number(engagement.start_epoch) : null,
    end_epoch: engagement.end_epoch != null ? Number(engagement.end_epoch) : null,
    start_time_label: startTimeLabel || null,
    duration_minutes:
      engagement.duration_minutes != null
        ? Number(engagement.duration_minutes)
        : null,
    base_amount:
      engagement.base_amount != null ? Number(engagement.base_amount) : null,
    address: addressLine || null,
    ...extras,
  };
}

/**
 * Merge stored notification metadata with joined engagement / payment columns (list API).
 * @param {object} row — notification row with optional eng_* / pay_* columns
 */
export function enrichAutoCancelNotificationMetadata(row) {
  const stored = parseNotificationMetadata(row.metadata);
  const engagementLike = {
    service_type: row.eng_service_type ?? stored.service_type,
    booking_type: row.eng_booking_type ?? stored.booking_type ?? "ON_DEMAND",
    start_date: row.eng_start_date ?? stored.start_date,
    end_date: row.eng_end_date ?? stored.end_date,
    start_epoch: row.eng_start_epoch ?? stored.start_epoch,
    end_epoch: row.eng_end_epoch ?? stored.end_epoch,
    duration_minutes: row.eng_duration_minutes ?? stored.duration_minutes,
    address: row.eng_address ?? stored.address,
    base_amount: row.eng_base_amount ?? stored.base_amount,
  };

  const refundAmount =
    stored.refund_amount_inr ??
    stored.total_amount ??
    row.pay_total_amount ??
    row.eng_base_amount;

  return buildBookingNotificationMetadata(engagementLike, {
    ...stored,
    total_amount:
      stored.total_amount != null
        ? Number(stored.total_amount)
        : refundAmount != null
          ? Number(refundAmount)
          : null,
    refund_amount_inr:
      stored.refund_amount_inr != null
        ? Number(stored.refund_amount_inr)
        : refundAmount != null
          ? Number(refundAmount)
          : null,
    cancellation_reason:
      stored.cancellation_reason ?? "No Provider Available / Provider Not Assigned",
    auto_cancelled: stored.auto_cancelled !== false,
  });
}
