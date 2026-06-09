/** Pure payment-pending reminder policy helpers (no DB / config imports). */

export const DEFAULT_PAYMENT_REMINDER_POLICY = {
  paymentPendingOffsetsMinutes: [15, 60, 180],
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

  return {
    paymentPendingOffsetsMinutes:
      normalized.length > 0
        ? normalized
        : [...DEFAULT_PAYMENT_REMINDER_POLICY.paymentPendingOffsetsMinutes],
  };
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
