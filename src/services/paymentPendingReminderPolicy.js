/** Pure payment-pending reminder policy helpers (no DB / config imports). */

export const DEFAULT_PAYMENT_REMINDER_POLICY = {
  paymentPendingOffsetsMinutes: [15, 60, 180],
  paymentPendingExpiryMinutes: 20,
};

export function clampReminderInt(value, min, max, fallback) {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function parsePaymentPendingPolicy(settings) {
  const raw = settings?.customerReminders;
  let offsets = raw?.paymentPendingOffsetsMinutes;
  if (!Array.isArray(offsets)) {
    offsets = DEFAULT_PAYMENT_REMINDER_POLICY.paymentPendingOffsetsMinutes;
  }
  const normalized = [
    ...new Set(
      offsets
        .map((v) => clampReminderInt(v, 1, 7 * 24 * 60, null))
        .filter((n) => n != null)
    ),
  ].sort((a, b) => a - b);

  const expiryMinutes = clampReminderInt(
    raw?.paymentPendingExpiryMinutes,
    5,
    7 * 24 * 60,
    DEFAULT_PAYMENT_REMINDER_POLICY.paymentPendingExpiryMinutes
  );

  return {
    paymentPendingOffsetsMinutes:
      normalized.length > 0
        ? normalized
        : [...DEFAULT_PAYMENT_REMINDER_POLICY.paymentPendingOffsetsMinutes],
    paymentPendingExpiryMinutes: expiryMinutes,
  };
}

/**
 * @param {object} engagement
 * @param {object} payment
 * @param {number} ageMinutes minutes since engagement.created_at
 * @param {number} expiryMinutes configured payment window
 */
export function isEligibleForPaymentTimeoutExpiry(
  engagement,
  payment,
  ageMinutes,
  expiryMinutes
) {
  if (!engagement || !payment) return false;
  const payStatus = String(payment.status || "").toUpperCase();
  if (payStatus !== "PENDING") return false;

  const engStatus = String(engagement.engagement_status || "").toUpperCase();
  if (!["PAYMENT_PENDING", "CREATED", ""].includes(engStatus)) return false;

  const taskStatus = String(engagement.task_status || "").toUpperCase();
  if (taskStatus === "CANCELLED") return false;

  const expiry = Number(expiryMinutes);
  if (!Number.isFinite(expiry) || expiry < 1) return false;
  if (Number(ageMinutes) < expiry) return false;

  return true;
}

/**
 * Pick the next reminder tier (minutes after booking) that is due and not yet sent.
 * @param {number} ageMinutes
 * @param {number[]} offsetsMinutes sorted ascending
 * @param {Set<number>} sentTiers
 */
export function resolveDuePaymentReminderTier(ageMinutes, offsetsMinutes, sentTiers) {
  for (const tier of offsetsMinutes) {
    if (ageMinutes >= tier && !sentTiers.has(tier)) {
      return tier;
    }
  }
  return null;
}
