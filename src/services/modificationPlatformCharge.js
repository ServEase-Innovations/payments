export const MODIFICATION_PLATFORM_FEE_RATE = 0.06;

function roundInr(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Modification fee: 6% platform charge on booking base only (no extra GST — same engagement).
 */
export function computeModificationPlatformCharge(bookingBaseAmount) {
  const booking_base = roundInr(bookingBaseAmount);
  if (!Number.isFinite(booking_base) || booking_base <= 0) {
    return {
      booking_base: 0,
      platform_fee: 0,
      gst: 0,
      taxes_and_fees: 0,
      total_amount: 0,
    };
  }
  const platform_fee = roundInr(booking_base * MODIFICATION_PLATFORM_FEE_RATE);
  return {
    booking_base,
    platform_fee,
    gst: 0,
    taxes_and_fees: platform_fee,
    total_amount: platform_fee,
  };
}
