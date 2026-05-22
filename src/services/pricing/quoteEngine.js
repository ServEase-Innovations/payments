import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import {
  findActivePlan,
  findRulesForPlan,
  countCustomerBookingsOnIstDay,
  countCustomerLifetimeBookings,
} from "./pricingRepository.js";
import { calculateOnDemandQuote } from "./onDemandPricing.js";
import {
  shortTermConstraints,
  calculateShortTermMultiDay,
  calculateShortTermPerVisit,
  calculateMonthlyQuote,
  useShortTermHourPackage,
} from "./shortTermPricing.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Cook uses the same active plans/rates as maid until dedicated COOK plans exist. */
export function planServiceType(serviceType) {
  const st = String(serviceType || "").trim().toUpperCase();
  if (st === "COOK") return "MAID";
  return st;
}

function pickRate(min, max, preference = "mid") {
  const a = num(min);
  const b = num(max, a);
  if (preference === "min") return Math.min(a, b);
  if (preference === "max") return Math.max(a, b);
  return Math.round(((a + b) / 2) * 100) / 100;
}

function durationDaysInclusive(startDate, endDate) {
  const s = dayjs(String(startDate).slice(0, 10));
  const e = dayjs(String(endDate || startDate).slice(0, 10));
  if (!s.isValid() || !e.isValid()) return 1;
  return Math.max(1, e.diff(s, "day") + 1);
}

function matchesDuration(condition, days) {
  const min = condition.durationDaysMin != null ? Number(condition.durationDaysMin) : null;
  const max = condition.durationDaysMax != null ? Number(condition.durationDaysMax) : null;
  if (min != null && days < min) return false;
  if (max != null && days > max) return false;
  return true;
}

function ruleApplies(rule, ctx) {
  const c = rule.condition_json || {};
  const kind = c.kind;

  if (kind === "DEFAULT_PROMO") return false;
  if (kind === "FIRST_BOOKING_LIFETIME") return ctx.lifetimeBookings === 0;
  if (kind === "NTH_BOOKING_LIFETIME") {
    const n = Number(c.n);
    return Number.isFinite(n) && n > 0 && (ctx.lifetimeBookings + 1) % n === 0;
  }
  if (kind === "FULL_DAY_HOURS") {
    const h = ctx.durationHours;
    if (h == null) return false;
    const minH = Number(c.hoursMin ?? 6);
    const maxH = Number(c.hoursMax ?? 8);
    return h >= minH && h <= maxH;
  }
  if (kind === "NTH_BOOKING_SAME_DAY_IST") {
    const n = Number(c.n);
    return Number.isFinite(n) && ctx.bookingsOnVisitDay + 1 >= n;
  }
  if (c.hours != null && ctx.durationHours != null) {
    return Number(c.hours) === Number(ctx.durationHours);
  }
  if (c.fromHour != null && ctx.durationHours != null) {
    return Number(ctx.durationHours) >= Number(c.fromHour);
  }
  if (c.durationDaysMin != null || c.durationDaysMax != null) {
    return matchesDuration(c, ctx.durationDays);
  }
  return false;
}

/**
 * @param {object} input
 * @param {string} input.serviceType
 * @param {string} input.bookingType
 * @param {number} [input.customerId]
 * @param {string} input.startDate YYYY-MM-DD
 * @param {string} [input.endDate]
 * @param {number} [input.durationHours] — for hourly / package quotes
 * @param {number} [input.hoursPerDay] — short-term daily window
 * @param {'min'|'max'|'mid'} [input.ratePreference]
 * @param {import('pg').PoolClient} [client]
 */
export async function calculateQuote(input, client) {
  const serviceType = String(input.serviceType || "").trim().toUpperCase();
  const bookingType = String(input.bookingType || "").trim().toUpperCase();
  const startDate = String(input.startDate || "").slice(0, 10);
  const endDate = String(input.endDate || startDate).slice(0, 10);
  const ratePreference = input.ratePreference || "mid";
  const durationHours = input.durationHours != null ? Number(input.durationHours) : null;
  const hoursPerDay = input.hoursPerDay != null ? Number(input.hoursPerDay) : null;

  if (!serviceType || !bookingType || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error("serviceType, bookingType, and startDate (YYYY-MM-DD) are required");
  }

  const planLookupType = planServiceType(serviceType);
  const plan = await findActivePlan(planLookupType, bookingType, startDate, client);
  if (!plan) {
    throw new Error(`No active pricing plan for ${planLookupType} / ${bookingType}`);
  }

  plan.unit = String(plan.unit || "").toUpperCase();
  const constraints = plan.constraints_json || {};
  const durationDays = durationDaysInclusive(startDate, endDate);

  if (constraints.maxDurationDays != null && durationDays > Number(constraints.maxDurationDays)) {
    throw new Error(`Short-term bookings cannot exceed ${constraints.maxDurationDays} days`);
  }

  let bookingsOnVisitDay = 0;
  let lifetimeBookings = 0;
  if (input.customerId != null) {
    bookingsOnVisitDay = await countCustomerBookingsOnIstDay(
      input.customerId,
      startDate,
      client
    );
    lifetimeBookings = await countCustomerLifetimeBookings(input.customerId, client);
  }

  const ctx = {
    durationDays,
    durationHours,
    hoursPerDay,
    bookingsOnVisitDay,
    lifetimeBookings,
    visitDate: startDate,
  };

  const rules = await findRulesForPlan(plan.plan_id, startDate, client);
  const appliedRules = [];
  const lineItems = [];
  const discounts = [];

  const baseRate = pickRate(plan.base_rate_min, plan.base_rate_max, ratePreference);
  let unitRate = baseRate;
  let total = 0;
  let pricingMode = plan.unit;
  let shortTermHourlyDisplay = null;
  let onDemandDisplay = null;

  // --- ON_DEMAND (hourly + 6–8h full-day band) ---
  if (plan.unit === "HOUR") {
    const hours = durationHours != null && durationHours > 0 ? durationHours : 1;
    const od = calculateOnDemandQuote({
      plan,
      hours,
      lifetimeBookings,
      ratePreference,
    });
    total = od.total;
    pricingMode = od.pricingMode;
    unitRate = od.unitRate;
    lineItems.push(...od.lineItems);
    appliedRules.push(...od.appliedRules);
    onDemandDisplay = od.display;
  }

  // --- SHORT_TERM ---
  else if (plan.unit === "DAY") {
    const st = shortTermConstraints(plan);
    const visitHours =
      durationHours != null && durationHours > 0
        ? durationHours
        : hoursPerDay != null && hoursPerDay > 0
          ? hoursPerDay
          : st.visitHoursDefault;

    const hourPackage = useShortTermHourPackage(durationDays, durationHours);

    if (hourPackage && durationHours >= 1) {
      const visit = calculateShortTermPerVisit(st, ratePreference, durationHours);
      total = visit.total;
      lineItems.push({
        description: visit.description,
        quantity: 1,
        unit: "PACKAGE",
        unit_rate: total,
        amount: total,
      });
      discounts.push(...visit.discounts);
      appliedRules.push(...visit.appliedRules);
      pricingMode = "PACKAGE";
    } else {
      const calc = calculateShortTermMultiDay(durationDays, st, ratePreference, visitHours);
      total = calc.total;
      const pkgBand = `₹${st.sevenDayPkgMin}–₹${st.sevenDayPkgMax}`;
      const desc =
        durationDays === 7
          ? `Short-term (7 days × 1h/d — ${pkgBand} package)`
          : durationDays < 7
            ? `Short-term (${durationDays}d × 1h/d — prorated from ${pkgBand} / 7 days)`
            : `Short-term (${durationDays}d × ${calc.hoursPerVisit}h/d — ${pkgBand} for 7d + extra days)`;
      lineItems.push({
        description: desc,
        quantity: 1,
        unit: "PACKAGE",
        unit_rate: calc.total,
        amount: calc.gross,
      });
      if (calc.hourDiscAmt > 0) {
        discounts.push({
          label: `${calc.incrementalHourDiscountPct}% off each hour above 1h (${calc.extraHours}h/visit × ${durationDays}d)`,
          amount: calc.hourDiscAmt,
        });
        appliedRules.push({
          rule_type: "INCREMENTAL_HOUR_DISCOUNT",
          label: `${calc.incrementalHourDiscountPct}% off hours above 1h per visit`,
        });
      }
      if (calc.discountAmt > 0) {
        discounts.push({
          label: `${calc.percentOff}% off days after first 7 (${durationDays - 7} extra days)`,
          amount: calc.discountAmt,
        });
        appliedRules.push({
          rule_type: "PERCENT_OFF",
          label: `${calc.percentOff}% on prorated extra days`,
        });
      } else if (durationDays === 7) {
        appliedRules.push({
          rule_type: "SEVEN_DAY_PKG",
          label: `7-day package ${pkgBand} (1h/day)`,
        });
      }
      shortTermHourlyDisplay = {
        min: st.sevenDayPkgMin,
        max: st.sevenDayPkgMax,
        baseMin: st.sevenDayPkgMin,
        baseMax: st.sevenDayPkgMax,
        perDayFromPkg: calc.perDayFromPkg,
        sevenDayPkg: calc.sevenDayPkg,
      };
      unitRate = calc.hourlyDisplay;
      pricingMode = "DAY";
    }
  }

  // --- MONTHLY ---
  else if (plan.unit === "MONTH") {
    const visitHours =
      durationHours != null && durationHours > 0
        ? durationHours
        : hoursPerDay != null && hoursPerDay > 0
          ? hoursPerDay
          : null;
    const monthly = calculateMonthlyQuote(plan, ratePreference, visitHours);
    total = monthly.total;
    lineItems.push({
      description: monthly.description,
      quantity: 1,
      unit: "MONTH",
      unit_rate: total,
      amount: total,
    });
    discounts.push(...monthly.discounts);
    appliedRules.push(...monthly.appliedRules);
    unitRate = monthly.baseMonthly;
    pricingMode = "MONTH";
  } else {
    throw new Error(`Unsupported plan unit: ${plan.unit}`);
  }

  const snapshot = {
    version: 1,
    quoted_at: new Date().toISOString(),
    service_type: serviceType,
    booking_type: bookingType,
    plan: {
      plan_id: plan.plan_id,
      code: plan.code,
      name: plan.name,
      unit: plan.unit,
      base_rate_min: num(plan.base_rate_min),
      base_rate_max: num(plan.base_rate_max),
      constraints,
    },
    input: {
      startDate,
      endDate,
      durationHours,
      hoursPerDay,
      ratePreference,
      customerId: input.customerId ?? null,
      lifetimeBookings,
    },
    applied_rules: appliedRules,
    line_items: lineItems,
    discounts,
    subtotal: total,
    total,
    display: {
      base_range: shortTermHourlyDisplay
        ? {
            min: shortTermHourlyDisplay.min,
            max: shortTermHourlyDisplay.max,
            unit: "HOUR",
            base_min: shortTermHourlyDisplay.baseMin,
            base_max: shortTermHourlyDisplay.baseMax,
          }
        : onDemandDisplay?.base_range
          ? onDemandDisplay.base_range
          : {
              min: num(plan.base_rate_min),
              max: num(plan.base_rate_max),
              unit: plan.unit,
            },
      unit_rate: unitRate,
      promo_rate: onDemandDisplay?.promo_rate ?? null,
    },
  };

  return {
    success: true,
    quote: snapshot,
    total,
    plan_code: plan.code,
  };
}

/**
 * Merge pricing snapshot into responsibilities JSON for engagements.
 */
export function attachPricingSnapshot(responsibilities, snapshot) {
  const base =
    responsibilities == null
      ? {}
      : typeof responsibilities === "string"
        ? JSON.parse(responsibilities)
        : { ...responsibilities };
  if (Array.isArray(base)) {
    return { tasks: base, pricing_snapshot: snapshot };
  }
  return { ...base, pricing_snapshot: snapshot };
}

export function validateQuotedAmount(baseAmount, snapshot, tolerance = 1) {
  if (!snapshot?.total) return true;
  const expected = num(snapshot.total);
  const actual = num(baseAmount);
  return Math.abs(actual - expected) <= tolerance;
}
