/**
 * Short-term maid pricing (business rules).
 *
 * Base hourly: ₹1050–₹1400 → 20% off → ₹850–₹1150/hr (7-day band).
 * Multi-day: 7 days @ 20% off; 8–15 days @ 25% off (on gross daily × days).
 * 2h visit: package ₹1499–₹2099, adjusted by 15% of excess over hourly build-up.
 * 3h visit: 2h total + 3rd hour @ discounted rate with 5% off that hour.
 */

export const ST_HOURLY_BASE_MIN = 1050;
export const ST_HOURLY_BASE_MAX = 1400;
export const ST_HOURLY_DISC_MIN = 850;
export const ST_HOURLY_DISC_MAX = 1150;
export const ST_TWO_HOUR_PKG_MIN = 1499;
export const ST_TWO_HOUR_PKG_MAX = 2099;
export const ST_DISC_7_DAYS_PCT = 20;
export const ST_DISC_8_15_DAYS_PCT = 25;
export const ST_SECOND_HOUR_PREMIUM_PCT = 15;
export const ST_THIRD_HOUR_DISC_PCT = 5;
/** 5% off each hour above visitHoursDefault (short-term multi-day & monthly add-ons). */
export const ST_INCREMENTAL_HOUR_DISC_PCT = 5;
/** Default visit length per day when times are not set (typical short-term slot). */
export const ST_DEFAULT_VISIT_HOURS = 2;
export const MONTHLY_DEFAULT_VISIT_HOURS = 2;
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
  return {
    hoursPerDay: positive(c.hoursPerDay, ST_DEFAULT_VISIT_HOURS),
    visitHoursDefault: positive(c.visitHoursDefault, ST_DEFAULT_VISIT_HOURS),
    hourlyBaseMin: positive(c.hourlyBaseMin, ST_HOURLY_BASE_MIN),
    hourlyBaseMax: positive(c.hourlyBaseMax, ST_HOURLY_BASE_MAX),
    hourlyDiscMin: positive(c.hourlyDiscMin, ST_HOURLY_DISC_MIN),
    hourlyDiscMax: positive(c.hourlyDiscMax, ST_HOURLY_DISC_MAX),
    twoHourPkgMin: positive(c.twoHourPkgMin, ST_TWO_HOUR_PKG_MIN),
    twoHourPkgMax: positive(c.twoHourPkgMax, ST_TWO_HOUR_PKG_MAX),
    secondHourPremiumPct: positive(c.secondHourPremiumPct, ST_SECOND_HOUR_PREMIUM_PCT),
    thirdHourDiscPct: positive(c.thirdHourDiscPct, ST_THIRD_HOUR_DISC_PCT),
    disc7DaysPct: positive(c.disc7DaysPct, ST_DISC_7_DAYS_PCT),
    disc8to15DaysPct: positive(c.disc8to15DaysPct, ST_DISC_8_15_DAYS_PCT),
    excessDiscountPct: positive(c.excessDiscountPct, ST_SECOND_HOUR_PREMIUM_PCT),
    incrementalHourDiscountPct: positive(
      c.incrementalHourDiscountPct,
      ST_INCREMENTAL_HOUR_DISC_PCT
    ),
  };
}

export function monthlyConstraints(plan) {
  const c = plan?.constraints_json || {};
  const st = shortTermConstraints(plan);
  return {
    ...st,
    visitHoursDefault: positive(c.visitHoursDefault, MONTHLY_DEFAULT_VISIT_HOURS),
    incrementalHourDiscountPct: positive(
      c.incrementalHourDiscountPct,
      ST_INCREMENTAL_HOUR_DISC_PCT
    ),
    daysPerMonth: positive(c.daysPerMonth, MONTHLY_DAYS_PER_MONTH),
  };
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
  const extraGross = Math.round(hourlyRate * extraHours * multiplier * 100) / 100;
  const extraNet =
    Math.round(hourlyRate * extraHours * multiplier * (1 - discountPct / 100) * 100) /
    100;
  return {
    extraGross,
    extraNet,
    discountAmt: Math.round((extraGross - extraNet) * 100) / 100,
  };
}

export function shortTermDurationPercentOff(durationDays, constraints) {
  /** 7-day band uses ₹850–₹1150/hr (20% already applied vs base). */
  if (durationDays === 7) return 0;
  if (durationDays >= 8 && durationDays <= 15) return constraints.disc8to15DaysPct;
  return 0;
}

/**
 * Multi-day short-term: discounted hourly (₹850–₹1150 for 7d band) × visit hours × days.
 * Optional extra % off for 8–15 day bookings only.
 */
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
      : constraints.visitHoursDefault || constraints.hoursPerDay || ST_DEFAULT_VISIT_HOURS
  );
  const baseline = constraints.visitHoursDefault || ST_DEFAULT_VISIT_HOURS;
  const hourlyRate = pickRate(constraints.hourlyDiscMin, constraints.hourlyDiscMax, ratePreference);
  const pct = constraints.incrementalHourDiscountPct;
  const baseHours = Math.min(visitHours, baseline);
  const extraHours = Math.max(0, visitHours - baseline);
  const basePortion = hourlyRate * baseHours * durationDays;
  const { extraNet, discountAmt: hourDiscAmt } = incrementalHourDiscountAmount(
    hourlyRate,
    extraHours,
    durationDays,
    pct
  );
  const gross = Math.round((basePortion + extraNet) * 100) / 100;
  const percentOff = shortTermDurationPercentOff(durationDays, constraints);
  const durationDiscountAmt = Math.round(gross * (percentOff / 100) * 100) / 100;
  const total = Math.round((gross - durationDiscountAmt) * 100) / 100;
  const dailyGross = Math.round((basePortion + extraNet) / durationDays * 100) / 100;

  return {
    total,
    gross,
    discountAmt: durationDiscountAmt,
    hourDiscAmt,
    percentOff,
    dailyGross,
    dailyRate: dailyGross,
    hourlyDisplay: hourlyRate,
    hoursPerVisit: visitHours,
    extraHours,
    incrementalHourDiscountPct: pct,
    hourlyBaseMin: constraints.hourlyBaseMin,
    hourlyBaseMax: constraints.hourlyBaseMax,
  };
}

/**
 * 2-hour visit: hourly build-up (h1 + h2 with 15% premium on h2) vs package band;
 * package − 15% × max(0, hourlyBuild − package).
 */
export function calculateShortTermTwoHours(constraints, ratePreference) {
  const hourRate = pickRate(constraints.hourlyDiscMin, constraints.hourlyDiscMax, ratePreference);
  const hour2Rate =
    Math.round(hourRate * (1 + constraints.secondHourPremiumPct / 100) * 100) / 100;
  const hourlyBuild = Math.round((hourRate + hour2Rate) * 100) / 100;
  const packageTotal = pickRate(constraints.twoHourPkgMin, constraints.twoHourPkgMax, ratePreference);
  const excess = Math.max(0, hourlyBuild - packageTotal);
  const excessDiscount =
    Math.round(excess * (constraints.excessDiscountPct / 100) * 100) / 100;
  const total = Math.round((packageTotal - excessDiscount) * 100) / 100;

  return {
    total,
    hourRate,
    hour2Rate,
    hourlyBuild,
    packageTotal,
    excess,
    excessDiscount,
  };
}

/**
 * 3-hour visit: 2h total + 3rd hour @ discounted rate − 5% on 3rd hour.
 */
export function calculateShortTermThreeHours(constraints, ratePreference) {
  const two = calculateShortTermTwoHours(constraints, ratePreference);
  const thirdHourRate = pickRate(constraints.hourlyDiscMin, constraints.hourlyDiscMax, ratePreference);
  const thirdDisc = Math.round(thirdHourRate * (constraints.thirdHourDiscPct / 100) * 100) / 100;
  const total = Math.round((two.total + thirdHourRate - thirdDisc) * 100) / 100;

  return {
    ...two,
    total,
    thirdHourRate,
    thirdDisc,
  };
}

/** Use per-visit hour packages only for short stints (< 7 days). */
export function useShortTermHourPackage(durationDays, durationHours) {
  if (durationHours == null || durationHours <= 0) return false;
  return durationDays < 7;
}

/**
 * Per-visit pricing for short stints (< 7 days): 1h, 2h pkg, 3h (+5% on 3rd), 4h+ (2h pkg + extra hrs @ 5% off).
 */
export function calculateShortTermPerVisit(constraints, ratePreference, visitHours) {
  const h = Math.max(1, Number(visitHours) || 1);
  const pct = constraints.incrementalHourDiscountPct;

  if (h < 2) {
    const hourRate = pickRate(
      constraints.hourlyDiscMin,
      constraints.hourlyDiscMax,
      ratePreference
    );
    return {
      total: hourRate,
      discounts: [],
      appliedRules: [{ rule_type: "SHORT_TERM_1H", label: `1h @ ₹${hourRate}/hr` }],
      description: `Maid short-term (1h @ ₹${hourRate}/hr)`,
    };
  }

  if (h === 2) {
    const calc = calculateShortTermTwoHours(constraints, ratePreference);
    const discounts = [];
    if (calc.excessDiscount > 0) {
      discounts.push({
        label: `${constraints.excessDiscountPct}% off excess above package (₹${calc.packageTotal})`,
        amount: calc.excessDiscount,
      });
    }
    return {
      total: calc.total,
      discounts,
      appliedRules: [
        {
          rule_type: "SHORT_TERM_2H",
          label: `2h package ₹${calc.packageTotal} (−${constraints.excessDiscountPct}% excess)`,
        },
      ],
      description: `Maid short-term (2h: ₹${calc.hourRate} + ₹${calc.hour2Rate} hr2, pkg adj.)`,
    };
  }

  if (h === 3) {
    const calc = calculateShortTermThreeHours(constraints, ratePreference);
    const discounts = [];
    if (calc.thirdDisc > 0) {
      discounts.push({
        label: `${constraints.thirdHourDiscPct}% off 3rd hour (₹${calc.thirdHourRate}/hr)`,
        amount: calc.thirdDisc,
      });
    }
    return {
      total: calc.total,
      discounts,
      appliedRules: [
        {
          rule_type: "SHORT_TERM_3H",
          label: `3rd hour ${constraints.thirdHourDiscPct}% discount`,
        },
      ],
      description: `Maid short-term (3h: 2h package + 3rd hr − ${constraints.thirdHourDiscPct}% on 3rd)`,
    };
  }

  const two = calculateShortTermTwoHours(constraints, ratePreference);
  const hourRate = pickRate(
    constraints.hourlyDiscMin,
    constraints.hourlyDiscMax,
    ratePreference
  );
  const extraHours = h - 2;
  const { extraNet, discountAmt } = incrementalHourDiscountAmount(
    hourRate,
    extraHours,
    1,
    pct
  );
  const discounts = [];
  if (two.excessDiscount > 0) {
    discounts.push({
      label: `${constraints.excessDiscountPct}% off excess above package (₹${two.packageTotal})`,
      amount: two.excessDiscount,
    });
  }
  if (discountAmt > 0) {
    discounts.push({
      label: `${pct}% off extra hours (${extraHours}h above 2h)`,
      amount: discountAmt,
    });
  }
  return {
    total: Math.round((two.total + extraNet) * 100) / 100,
    discounts,
    appliedRules: [
      {
        rule_type: "INCREMENTAL_HOUR_DISCOUNT",
        label: `${pct}% off hours above 2h (${extraHours} extra hr)`,
      },
    ],
    description: `Maid short-term (${h}h: 2h package + ${extraHours}h @ ${pct}% off)`,
  };
}

/**
 * Monthly: base contract (covers default hrs/day) + extra hours/day at hourly band − 5%.
 */
export function calculateMonthlyQuote(plan, ratePreference, hoursPerDay) {
  const mc = monthlyConstraints(plan);
  const baseMonthly = pickRate(plan.base_rate_min, plan.base_rate_max, ratePreference);
  const h =
    hoursPerDay != null && hoursPerDay > 0
      ? Number(hoursPerDay)
      : mc.visitHoursDefault;
  const extraHours = Math.max(0, h - mc.visitHoursDefault);
  const hourlyRate = pickRate(mc.hourlyDiscMin, mc.hourlyDiscMax, ratePreference);
  const { extraNet, discountAmt } = incrementalHourDiscountAmount(
    hourlyRate,
    extraHours,
    mc.daysPerMonth,
    mc.incrementalHourDiscountPct
  );
  const total = Math.round((baseMonthly + extraNet) * 100) / 100;
  const discounts = [];
  if (discountAmt > 0) {
    discounts.push({
      label: `${mc.incrementalHourDiscountPct}% off extra hours (${extraHours}h/day × ${mc.daysPerMonth} days)`,
      amount: discountAmt,
    });
  }
  return {
    total,
    baseMonthly,
    extraNet,
    discounts,
    hoursPerDay: h,
    extraHours,
    appliedRules:
      extraHours > 0
        ? [
            {
              rule_type: "MONTHLY_EXTRA_HOURS",
              label: `+${extraHours}h/day @ ${mc.incrementalHourDiscountPct}% off (₹${hourlyRate}/hr band)`,
            },
          ]
        : [{ rule_type: "MONTHLY_BASE", label: "Monthly contract (standard hours)" }],
    description:
      extraHours > 0
        ? `Maid monthly (base + ${extraHours}h/day extra @ ${mc.incrementalHourDiscountPct}% off)`
        : "Maid monthly contract",
  };
}
