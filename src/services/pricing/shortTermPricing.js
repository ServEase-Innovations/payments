/**
 * Short-term maid/cook pricing.
 *
 * - ₹1050–₹1400 = **flat price for a 7-day booking at 1 hour/day** (not per hour per day).
 * - Below 7 days: prorate that package (÷7 × days), no duration discount.
 * - Exactly 7 days @ 1 hr/day: full 7-day package amount.
 * - 8–15 days @ 1 hr/day: 7-day package + extra days prorated at (package÷7), 25% off extra days only.
 * - Each hour above 1 per visit: 5% off (priced at package÷7 per hour).
 */

export const ST_SEVEN_DAY_PKG_MIN = 1050;
export const ST_SEVEN_DAY_PKG_MAX = 1400;
/** @deprecated display only — was old discounted hourly band */
export const ST_HOURLY_DISC_MIN = 850;
export const ST_HOURLY_DISC_MAX = 1150;
export const ST_DISC_8_15_DAYS_PCT = 25;
export const ST_INCREMENTAL_HOUR_DISC_PCT = 5;
export const ST_INCREMENTAL_BASELINE_HOURS = 1;
export const ST_DEFAULT_VISIT_HOURS = 1;
/** Standard monthly contract covers 1 hour per visit (30-day period). */
export const MONTHLY_DEFAULT_VISIT_HOURS = 1;
export const MONTHLY_DAYS_PER_MONTH = 26;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function positive(v, fallback) {
  const n = num(v, fallback);
  return n > 0 ? n : fallback;
}

export function pickRate(min, max, preference = "mid") {
  const a = num(min);
  const b = num(max, a);
  if (preference === "min") return Math.min(a, b);
  if (preference === "max") return Math.max(a, b);
  return Math.round(((a + b) / 2) * 100) / 100;
}

export function shortTermConstraints(plan) {
  const c = plan?.constraints_json || {};
  const pkgMin = positive(
    c.sevenDayPkgMin ?? c.hourlyBaseMin,
    ST_SEVEN_DAY_PKG_MIN
  );
  const pkgMax = positive(
    c.sevenDayPkgMax ?? c.hourlyBaseMax,
    ST_SEVEN_DAY_PKG_MAX
  );
  return {
    hoursPerDay: positive(c.hoursPerDay, ST_DEFAULT_VISIT_HOURS),
    visitHoursDefault: positive(c.visitHoursDefault, ST_DEFAULT_VISIT_HOURS),
    sevenDayPkgMin: pkgMin,
    sevenDayPkgMax: pkgMax,
    hourlyBaseMin: pkgMin,
    hourlyBaseMax: pkgMax,
    disc8to15DaysPct: positive(c.disc8to15DaysPct, ST_DISC_8_15_DAYS_PCT),
    incrementalBaselineHours: positive(
      c.incrementalBaselineHours,
      ST_INCREMENTAL_BASELINE_HOURS
    ),
    incrementalHourDiscountPct: positive(
      c.incrementalHourDiscountPct,
      ST_INCREMENTAL_HOUR_DISC_PCT
    ),
  };
}

export function monthlyConstraints(plan) {
  const c = plan?.constraints_json || {};
  const visitHoursDefault = positive(
    c.visitHoursDefault,
    MONTHLY_DEFAULT_VISIT_HOURS
  );
  return {
    visitHoursDefault,
    includedVisitHours: positive(
      c.includedVisitHours ?? c.visitHoursDefault,
      visitHoursDefault
    ),
    hourlyDiscMin: positive(c.hourlyDiscMin, ST_HOURLY_DISC_MIN),
    hourlyDiscMax: positive(c.hourlyDiscMax, ST_HOURLY_DISC_MAX),
    incrementalHourDiscountPct: positive(
      c.incrementalHourDiscountPct,
      ST_INCREMENTAL_HOUR_DISC_PCT
    ),
    daysPerMonth: positive(c.daysPerMonth, MONTHLY_DAYS_PER_MONTH),
  };
}

export function sevenDayPackageRate(constraints, ratePreference = "mid") {
  return pickRate(
    constraints.sevenDayPkgMin,
    constraints.sevenDayPkgMax,
    ratePreference
  );
}

/** Implied per-calendar-day rate when prorating the 7-day package. */
export function dailyRateFrom7DayPackage(pkg7d) {
  return Math.round((pkg7d / 7) * 100) / 100;
}

function incrementalHourDiscountAmount(
  hourlyRate,
  extraHours,
  multiplier,
  discountPct
) {
  if (extraHours <= 0 || multiplier <= 0) {
    return { extraNet: 0, discountAmt: 0, extraGross: 0 };
  }
  const extraGross =
    Math.round(hourlyRate * extraHours * multiplier * 100) / 100;
  const extraNet =
    Math.round(
      hourlyRate * extraHours * multiplier * (1 - discountPct / 100) * 100
    ) / 100;
  return {
    extraGross,
    extraNet,
    discountAmt: Math.round((extraGross - extraNet) * 100) / 100,
  };
}

/**
 * Core tenure charge for 1 hr/day visits from the 7-day package model.
 */
export function calculateShortTermTenureCharge(
  durationDays,
  constraints,
  ratePreference
) {
  const pkg7d = sevenDayPackageRate(constraints, ratePreference);
  const perDay = dailyRateFrom7DayPackage(pkg7d);
  const pctExtra = constraints.disc8to15DaysPct;

  if (durationDays < 7) {
    const gross = Math.round(perDay * durationDays * 100) / 100;
    return {
      tenureGross: gross,
      tenureTotal: gross,
      durationDiscountAmt: 0,
      percentOff: 0,
      pkg7d,
      perDay,
      pricingMode: "PRORATE_7D_PKG",
    };
  }

  if (durationDays === 7) {
    return {
      tenureGross: pkg7d,
      tenureTotal: pkg7d,
      durationDiscountAmt: 0,
      percentOff: 0,
      pkg7d,
      perDay,
      pricingMode: "SEVEN_DAY_PKG",
    };
  }

  if (durationDays <= 15) {
    const extraDays = durationDays - 7;
    const extraGross = Math.round(perDay * extraDays * 100) / 100;
    const extraNet =
      Math.round(extraGross * (1 - pctExtra / 100) * 100) / 100;
    const durationDiscountAmt =
      Math.round((extraGross - extraNet) * 100) / 100;
    const tenureTotal = Math.round((pkg7d + extraNet) * 100) / 100;
    return {
      tenureGross: Math.round((pkg7d + extraGross) * 100) / 100,
      tenureTotal,
      durationDiscountAmt,
      percentOff: pctExtra,
      pkg7d,
      perDay,
      extraDays,
      pricingMode: "SEVEN_DAY_PKG_PLUS_EXTRA",
    };
  }

  const gross = Math.round(perDay * durationDays * 100) / 100;
  return {
    tenureGross: gross,
    tenureTotal: gross,
    durationDiscountAmt: 0,
    percentOff: 0,
    pkg7d,
    perDay,
    pricingMode: "PRORATE_7D_PKG",
  };
}

/** @deprecated use calculateShortTermTenureCharge */
export function shortTermDurationPercentOff(durationDays, constraints) {
  if (durationDays >= 8 && durationDays <= 15) return constraints.disc8to15DaysPct;
  return 0;
}

export function calculateShortTermMultiDay(
  durationDays,
  constraints,
  ratePreference,
  hoursPerVisit
) {
  const visitHours = Math.max(
    1,
    hoursPerVisit != null && hoursPerVisit > 0
      ? Number(hoursPerVisit)
      : constraints.visitHoursDefault || ST_DEFAULT_VISIT_HOURS
  );
  const baseline = constraints.incrementalBaselineHours || ST_INCREMENTAL_BASELINE_HOURS;
  const pct = constraints.incrementalHourDiscountPct;

  const tenure = calculateShortTermTenureCharge(
    durationDays,
    constraints,
    ratePreference
  );
  const perDay = tenure.perDay;

  const extraHoursPerVisit = Math.max(0, visitHours - baseline);
  const { extraNet, discountAmt: hourDiscAmt } = incrementalHourDiscountAmount(
    perDay,
    extraHoursPerVisit,
    durationDays,
    pct
  );

  const gross = Math.round((tenure.tenureGross + extraNet) * 100) / 100;
  const total = Math.round((tenure.tenureTotal + extraNet) * 100) / 100;
  const dailyGross = Math.round(gross / durationDays * 100) / 100;

  return {
    total,
    gross,
    discountAmt: tenure.durationDiscountAmt,
    hourDiscAmt,
    percentOff: tenure.percentOff,
    dailyGross,
    dailyRate: dailyGross,
    hourlyDisplay: perDay,
    hoursPerVisit: visitHours,
    extraHours: extraHoursPerVisit,
    incrementalHourDiscountPct: pct,
    sevenDayPkg: tenure.pkg7d,
    perDayFromPkg: perDay,
    pricingMode: tenure.pricingMode,
    hourlyBaseMin: constraints.sevenDayPkgMin,
    hourlyBaseMax: constraints.sevenDayPkgMax,
  };
}

/** Single-calendar-day booking uses same package proration. */
export function useShortTermHourPackage(durationDays, durationHours) {
  return durationDays <= 1 && durationHours != null && durationHours > 0;
}

export function calculateShortTermPerVisit(
  constraints,
  ratePreference,
  visitHours
) {
  const h = Math.max(1, Number(visitHours) || 1);
  const tenure = calculateShortTermTenureCharge(1, constraints, ratePreference);
  const perDay = tenure.perDay;
  const pct = constraints.incrementalHourDiscountPct;
  const baseline = constraints.incrementalBaselineHours || ST_INCREMENTAL_BASELINE_HOURS;
  const extraHours = Math.max(0, h - baseline);

  let total = tenure.tenureTotal;
  const discounts = [];
  const appliedRules = [
    {
      rule_type: "SHORT_TERM_1D",
      label: `1 day (prorated 7-day pkg ₹${tenure.pkg7d} → ₹${perDay}/day @ 1h)`,
    },
  ];

  if (extraHours > 0) {
    const { extraNet, discountAmt } = incrementalHourDiscountAmount(
      perDay,
      extraHours,
      1,
      pct
    );
    total = Math.round((total + extraNet) * 100) / 100;
    if (discountAmt > 0) {
      discounts.push({
        label: `${pct}% off each hour above ${baseline}h (${extraHours}h)`,
        amount: discountAmt,
      });
    }
  }

  return {
    total,
    discounts,
    appliedRules,
    description: `Short-term (1 day, ${h}h — 7-day package prorated)`,
  };
}

/**
 * Monthly contract (30 days):
 * - 1st included hour = full base monthly rate (e.g. ₹4,999 mid).
 * - Each extra hour per visit adds the same base amount minus promo% (5% off → 95% of base per hour).
 * - Total = 1st hour + 2nd hour + … (additive, not × days in month).
 */
export function calculateMonthlyQuote(plan, ratePreference, hoursPerDay) {
  const mc = monthlyConstraints(plan);
  const baseMonthly = pickRate(plan.base_rate_min, plan.base_rate_max, ratePreference);
  const h =
    hoursPerDay != null && hoursPerDay > 0
      ? Number(hoursPerDay)
      : mc.visitHoursDefault;
  const includedHours = mc.includedVisitHours;
  const extraHours = Math.max(0, h - includedHours);
  const pct = mc.incrementalHourDiscountPct;
  const extraHourRate =
    Math.round(baseMonthly * (1 - pct / 100) * 100) / 100;

  let extraNet = 0;
  const discounts = [];
  const appliedRules = [
    { rule_type: "MONTHLY_BASE", label: "1st hour — monthly contract (30 days)" },
  ];

  if (extraHours > 0) {
    extraNet = Math.round(extraHourRate * extraHours * 100) / 100;
    const grossExtra = Math.round(baseMonthly * extraHours * 100) / 100;
    const discountAmt = Math.round((grossExtra - extraNet) * 100) / 100;
    if (discountAmt > 0) {
      discounts.push({
        label: `${pct}% off each extra hour (×${extraHours}h)`,
        amount: discountAmt,
      });
    }
    appliedRules.push({
      rule_type: "MONTHLY_EXTRA_HOUR_PROMO",
      label: `+${extraHours}h @ ${pct}% off 1st-hour rate (₹${extraHourRate}/h)`,
    });
  }

  const total = Math.round((baseMonthly + extraNet) * 100) / 100;

  const lineItems = [
    {
      description: "1st hour — monthly contract (30 days)",
      quantity: 1,
      unit: "HOUR",
      unit_rate: baseMonthly,
      amount: baseMonthly,
    },
  ];
  for (let i = 0; i < extraHours; i++) {
    const hourNum = includedHours + 1 + i;
    lineItems.push({
      description: `Hour ${hourNum} (${pct}% off 1st-hour rate)`,
      quantity: 1,
      unit: "HOUR",
      unit_rate: extraHourRate,
      amount: extraHourRate,
    });
  }

  return {
    total,
    baseMonthly,
    extraNet,
    extraHourRate,
    discounts,
    lineItems,
    hoursPerDay: h,
    extraHours,
    appliedRules,
    description:
      extraHours > 0
        ? `Monthly (${includedHours}h base + ${extraHours}h @ ${pct}% off each)`
        : "Maid monthly contract",
  };
}

/**
 * Nanny caregiver short-term pricing.
 *   - ₹4,999 baseline for 7 days @ 8 hours/day.
 *   - Prorated per-day.
 *   - For 4 hours/day: half of 8 hours package rate.
 */
export function calculateNannyShortTermQuote({ plan, durationDays, hoursPerDay }) {
  const c = plan?.constraints_json || {};
  const base7dRate = Number(c.sevenDayPkgRate ?? 4999);
  
  // Clamp durationHours/hoursPerDay to either 4 or 8
  const h = Number(hoursPerDay) === 8 ? 8 : 4;
  
  // Base 7-day package rate
  const pkg7d = h === 8 ? base7dRate : base7dRate / 2;
  const perDayRate = pkg7d / 7;
  
  const total = Math.round(perDayRate * durationDays);
  
  return {
    total,
    pricingMode: "PACKAGE",
    unitRate: Math.round(perDayRate * 100) / 100,
    hours: h,
    lineItems: [
      {
        description: `Nanny caregiver short-term (${durationDays} days @ ${h}h/day)`,
        quantity: durationDays,
        unit: "DAY",
        unit_rate: Math.round(perDayRate * 100) / 100,
        amount: total,
      }
    ],
    appliedRules: [
      {
        rule_type: "NANNY_SHORT_TERM",
        label: `Short-term caregiver (${h}h/day) — ₹${total}`,
      }
    ],
    discounts: [],
    display: {
      base_range: { min: Math.round(base7dRate / 2), max: base7dRate, unit: "PACKAGE" },
      unit_rate: Math.round(perDayRate * 100) / 100,
    }
  };
}
