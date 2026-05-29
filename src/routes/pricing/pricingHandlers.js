import { calculateQuote, planServiceType } from "../../services/pricing/quoteEngine.js";
import {
  findActivePlan,
  findRulesForPlan,
  listPlans,
  insertQuoteLog,
} from "../../services/pricing/pricingRepository.js";

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handlePostQuote(req, res) {
  try {
    const body = req.body || {};
    const result = await calculateQuote({
      serviceType: body.serviceType || body.service_type,
      bookingType: body.bookingType || body.booking_type,
      customerId: body.customerId ?? body.customer_id,
      couponCode: body.couponCode ?? body.coupon_code,
      city: body.city,
      startDate: body.startDate || body.start_date,
      endDate: body.endDate || body.end_date,
      durationHours: body.durationHours ?? body.duration_hours,
      hoursPerDay: body.hoursPerDay ?? body.hours_per_day,
      ratePreference: body.ratePreference || body.rate_preference || "mid",
    });

    let quoteId;
    try {
      quoteId = await insertQuoteLog({
        serviceType: result.quote.service_type,
        bookingType: result.quote.booking_type,
        customerId: body.customerId ?? body.customer_id,
        requestJson: body,
        responseJson: result.quote,
        quotedTotal: result.total,
      });
    } catch (logErr) {
      console.warn("pricing/quote: quote log insert failed:", logErr.message);
    }

    return res.json({
      ...result,
      total: Number(result.total) || Number(result.quote?.total) || 0,
      quote_id: quoteId,
    });
  } catch (err) {
    const msg = err.message || "Quote failed";
    const status =
      err.status ??
      (msg.includes("No active pricing") || msg.includes("cannot exceed") ? 400 : 500);
    if (status === 500) console.error("pricing/quote:", err);
    return res.status(status).json({ success: false, error: msg });
  }
}

export async function handleListPlans(req, res) {
  try {
    const plans = await listPlans({
      serviceType: req.query.serviceType || req.query.service_type,
      activeOnly: req.query.activeOnly !== "false",
    });

    const withRules = await Promise.all(
      plans.map(async (p) => {
        const rules = await findRulesForPlan(p.plan_id);
        return { ...p, rules };
      })
    );

    return res.json({ success: true, plans: withRules });
  } catch (err) {
    console.error("pricing/plans:", err);
    return res.status(500).json({ success: false, error: "Failed to list plans" });
  }
}

export async function handleGetPlanByBookingType(req, res) {
  try {
    const plan = await findActivePlan(
      planServiceType(req.params.serviceType),
      req.params.bookingType
    );
    if (!plan) {
      return res.status(404).json({ success: false, error: "Plan not found" });
    }
    const rules = await findRulesForPlan(plan.plan_id);
    return res.json({ success: true, plan, rules });
  } catch (err) {
    console.error("pricing/plan:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch plan" });
  }
}
