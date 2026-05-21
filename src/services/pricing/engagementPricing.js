import {
  calculateQuote,
  attachPricingSnapshot,
  validateQuotedAmount,
} from "./quoteEngine.js";

const PRICING_SERVICES = new Set(["MAID", "COOK"]);

/**
 * When client sends pricing_quote input or use_pricing_engine=true, compute quote and validate base_amount.
 * Returns { responsibilities, pricing_snapshot, quotedTotal } or null if skipped.
 */
export async function resolvePricingForEngagement(body, client) {
  const serviceType = String(body.service_type || body.serviceType || "").trim().toUpperCase();
  if (!PRICING_SERVICES.has(serviceType)) return null;

  const useEngine =
    body.use_pricing_engine === true ||
    body.usePricingEngine === true ||
    body.pricing_quote != null ||
    body.pricingQuote != null;

  const existingSnapshot =
    body.pricing_snapshot || body.pricingSnapshot || null;

  if (!useEngine && !existingSnapshot) return null;

  let snapshot = existingSnapshot;
  if (useEngine && !snapshot) {
    const q = body.pricing_quote || body.pricingQuote || {};
    const result = await calculateQuote(
      {
        serviceType,
        bookingType: body.booking_type || body.bookingType,
        customerId: body.customerid || body.customerId,
        startDate: body.start_date || body.startDate || q.startDate,
        endDate: body.end_date || body.endDate || q.endDate,
        durationHours: q.durationHours ?? q.duration_hours ?? body.duration_hours,
        hoursPerDay: q.hoursPerDay ?? q.hours_per_day ?? body.hours_per_day,
        ratePreference: q.ratePreference || q.rate_preference || "mid",
      },
      client
    );
    snapshot = result.quote;
  }

  const addonTotal = Number(body.addon_total ?? body.addonTotal ?? 0) || 0;
  const baseAmount = Number(body.base_amount ?? body.baseAmount);
  if (snapshot && Number.isFinite(baseAmount)) {
    const expectedTotal = Number(snapshot.total) + addonTotal;
    if (!validateQuotedAmount(baseAmount, { total: expectedTotal })) {
      throw new Error(
        `base_amount (${baseAmount}) does not match quoted total (${expectedTotal}, rate ${snapshot.total} + addons ${addonTotal}). Call POST /api/pricing/quote first.`
      );
    }
    if (addonTotal > 0) {
      snapshot.addon_total = addonTotal;
      snapshot.total = expectedTotal;
    }
  }

  const responsibilities = attachPricingSnapshot(body.responsibilities, snapshot);

  return {
    responsibilities,
    pricing_snapshot: snapshot,
    quotedTotal: snapshot?.total ?? baseAmount,
  };
}
