/**
 * On-demand (hourly) pricing:
 * - Standard: ₹150–₹200 / hr (mid = ₹175)
 * - Promo ₹99 / hr: customer's 1st booking ever, then every 6th booking (6, 12, 18…)
 * - Full-day visit (6–8 hr in one booking): ₹720–₹950 flat (not per-hour)
 */

export const OD_HOURLY_MIN = 150;
export const OD_HOURLY_MAX = 200;
export const OD_PROMO_HOURLY = 99;
export const OD_FULL_DAY_MIN = 720;
export const OD_FULL_DAY_MAX = 950;
export const OD_FULL_DAY_HOURS_MIN = 6;
export const OD_FULL_DAY_HOURS_MAX = 8;
export const OD_PROMO_EVERY_N = 6;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function pickRate(min, max, preference = "mid") {
  const a = num(min);
  const b = num(max, a);
  if (preference === "min") return Math.min(a, b);
  if (preference === "max") return Math.max(a, b);
  return Math.round(((a + b) / 2) * 100) / 100;
}

export function onDemandConstraints(plan) {
  const c = plan?.constraints_json || {};
  return {
    hourlyMin: num(c.hourlyMin, OD_HOURLY_MIN),
    hourlyMax: num(c.hourlyMax, OD_HOURLY_MAX),
    promoHourly: num(c.promoHourlyRate, OD_PROMO_HOURLY),
    promoEveryN: num(c.promoEveryN, OD_PROMO_EVERY_N),
    fullDayMin: num(c.fullDayRateMin, OD_FULL_DAY_MIN),
    fullDayMax: num(c.fullDayRateMax, OD_FULL_DAY_MAX),
    fullDayHoursMin: num(c.fullDayHoursMin, OD_FULL_DAY_HOURS_MIN),
    fullDayHoursMax: num(c.fullDayHoursMax, OD_FULL_DAY_HOURS_MAX),
  };
}

/** @param {number} lifetimeBookings — completed bookings before this quote */
export function qualifiesOnDemandPromo(lifetimeBookings) {
  const prior = num(lifetimeBookings, 0);
  const visitNumber = prior + 1;
  if (visitNumber === 1) return { eligible: true, reason: "first" };
  if (visitNumber % OD_PROMO_EVERY_N === 0) {
    return { eligible: true, reason: "nth", visitNumber };
  }
  return { eligible: false };
}

/**
 * @param {object} opts
 * @param {object} opts.plan
 * @param {number} opts.hours
 * @param {number} opts.lifetimeBookings
 * @param {'min'|'max'|'mid'} opts.ratePreference
 */
export function calculateOnDemandQuote({ plan, hours, lifetimeBookings, ratePreference = "mid" }) {
  const od = onDemandConstraints(plan);
  const h = num(hours, 1) > 0 ? num(hours, 1) : 1;

  if (h >= od.fullDayHoursMin && h <= od.fullDayHoursMax) {
    const total = pickRate(od.fullDayMin, od.fullDayMax, ratePreference);
    return {
      total,
      pricingMode: "DAY",
      unitRate: total,
      hours: h,
      lineItems: [
        {
          description: `On-demand full day (${od.fullDayHoursMin}–${od.fullDayHoursMax} hr) — ₹${od.fullDayMin}–₹${od.fullDayMax}`,
          quantity: 1,
          unit: "DAY",
          unit_rate: total,
          amount: total,
        },
      ],
      appliedRules: [
        {
          rule_type: "FULL_DAY_PACKAGE",
          label: `Full day (${h} hr) — ₹${total}`,
        },
      ],
      discounts: [],
      display: {
        base_range: { min: od.fullDayMin, max: od.fullDayMax, unit: "DAY" },
        unit_rate: total,
      },
    };
  }

  const promo = qualifiesOnDemandPromo(lifetimeBookings);
  const unitRate = promo.eligible
    ? od.promoHourly
    : pickRate(od.hourlyMin, od.hourlyMax, ratePreference);

  const total = Math.round(unitRate * h * 100) / 100;
  const promoLabel =
    promo.reason === "first"
      ? `Promo — ₹${od.promoHourly}/hr (1st booking)`
      : promo.reason === "nth"
        ? `Promo — ₹${od.promoHourly}/hr (${promo.visitNumber}th booking)`
        : `Promo — ₹${od.promoHourly}/hr`;

  return {
    total,
    pricingMode: "HOUR",
    unitRate,
    hours: h,
    lineItems: [
      {
        description: `On-demand (${h} hr @ ₹${unitRate}/hr)`,
        quantity: h,
        unit: "HOUR",
        unit_rate: unitRate,
        amount: total,
      },
    ],
    appliedRules: promo.eligible
      ? [{ rule_type: "PROMO_HOURLY", label: promoLabel }]
      : [
          {
            rule_type: "STANDARD_HOURLY",
            label: `Standard — ₹${od.hourlyMin}–₹${od.hourlyMax}/hr`,
          },
        ],
    discounts: [],
    display: {
      base_range: { min: od.hourlyMin, max: od.hourlyMax, unit: "HOUR" },
      unit_rate: unitRate,
      promo_rate: od.promoHourly,
    },
  };
}
