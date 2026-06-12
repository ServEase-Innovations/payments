import { createInAppNotification, InAppTypes } from "./inAppNotification.service.js";

function formatYmd(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().slice(0, 10);
  return String(value).slice(0, 10);
}

function formatDateRange(start, end) {
  const s = formatYmd(start);
  const e = formatYmd(end);
  if (!s || !e) return "";
  return s === e ? s : `${s} to ${e}`;
}

/**
 * Notify customer and assigned provider after vacation apply / modify / cancel.
 * Safe to call after transaction commit; failures are logged only.
 */
export async function sendVacationInAppNotifications({
  engagement,
  modificationType,
  vacationStartDate = null,
  vacationEndDate = null,
  leaveDays = null,
  refundAmount = null,
  penalty = null,
  refundReversed = null,
}) {
  if (!engagement) return;

  const engagementId = Number(engagement.engagement_id);
  const customerId = Number(engagement.customerid);
  const providerId =
    engagement.serviceproviderid != null ? Number(engagement.serviceproviderid) : null;

  if (!Number.isFinite(engagementId) || !Number.isFinite(customerId)) return;

  const modType = String(modificationType || "").toUpperCase();
  const range = formatDateRange(vacationStartDate, vacationEndDate);
  const daysLabel = leaveDays != null ? `${leaveDays} day(s)` : null;

  let customerTitle = "Vacation update";
  let customerBody = `Booking #${engagementId} vacation was updated.`;
  let providerTitle = "Customer vacation update";
  let providerBody = `Booking #${engagementId} vacation was updated.`;
  let type = InAppTypes.VACATION_UPDATED;

  if (modType === "VACATION_ADDED") {
    type = InAppTypes.VACATION_APPLIED;
    customerTitle = "Vacation applied";
    customerBody = `Vacation for booking #${engagementId} is confirmed${range ? ` (${range}` : ""}${daysLabel ? `, ${daysLabel}` : ""}${range ? ")" : ""}.`;
    if (refundAmount != null && Number(refundAmount) > 0) {
      customerBody += ` ₹${Number(refundAmount).toFixed(2)} credited to your wallet.`;
    }
    providerTitle = "Customer on vacation";
    providerBody = `Booking #${engagementId} is on vacation${range ? ` from ${range}` : ""}${daysLabel ? ` (${daysLabel})` : ""}. You are free on these dates.`;
  } else if (modType === "VACATION_MODIFIED") {
    type = InAppTypes.VACATION_UPDATED;
    customerTitle = "Vacation updated";
    customerBody = `Vacation dates for booking #${engagementId} were updated${range ? ` to ${range}` : ""}${daysLabel ? ` (${daysLabel})` : ""}.`;
    if (penalty != null && Number(penalty) > 0) {
      customerBody += ` A modification fee of ₹${Number(penalty).toFixed(2)} was charged.`;
    }
    if (refundAmount != null && Number(refundAmount) > 0) {
      customerBody += ` ₹${Number(refundAmount).toFixed(2)} credited to your wallet.`;
    }
    providerTitle = "Vacation dates changed";
    providerBody = `Customer updated vacation for booking #${engagementId}${range ? ` (${range})` : ""}. Please check your calendar.`;
  } else if (modType === "VACATION_CANCELLED") {
    type = InAppTypes.VACATION_CANCELLED;
    customerTitle = "Vacation cancelled";
    customerBody = `Vacation for booking #${engagementId} has been cancelled. Your regular service schedule applies again.`;
    if (refundReversed != null && Number(refundReversed) > 0) {
      customerBody += ` ₹${Number(refundReversed).toFixed(2)} was adjusted on your wallet.`;
    }
    providerTitle = "Vacation cancelled";
    providerBody = `Customer cancelled vacation for booking #${engagementId}. Please resume service on the regular schedule.`;
  }

  const metadata = {
    modification_type: modType,
    vacation_start_date: formatYmd(vacationStartDate) || null,
    vacation_end_date: formatYmd(vacationEndDate) || null,
    leave_days: leaveDays,
    refund_amount: refundAmount,
    penalty,
    refund_reversed: refundReversed,
  };

  try {
    await createInAppNotification({
      recipientType: "customer",
      recipientId: customerId,
      type,
      title: customerTitle,
      body: customerBody,
      engagementId,
      metadata,
    });
  } catch (err) {
    console.error("vacation notification (customer) failed:", err);
  }

  if (!Number.isFinite(providerId) || providerId < 1) return;

  try {
    await createInAppNotification({
      recipientType: "provider",
      recipientId: providerId,
      type,
      title: providerTitle,
      body: providerBody,
      engagementId,
      metadata,
    });
  } catch (err) {
    console.error("vacation notification (provider) failed:", err);
  }
}
