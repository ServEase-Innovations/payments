import pool from "../../config/db.js";
import { PG_IST_TODAY_DATE } from "../../config/istDateSql.js";

/**
 * @param {import('pg').PoolClient} [client]
 */
export async function findActivePlan(serviceType, bookingType, asOfDate = null, client = pool) {
  const st = String(serviceType || "").trim().toUpperCase();
  const bt = String(bookingType || "").trim().toUpperCase();
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);

  const { rows } = await client.query(
    `
    SELECT *
    FROM pricing_plan
    WHERE UPPER(service_type) = $1
      AND UPPER(booking_type) = $2
      AND is_active = TRUE
      AND effective_from <= $3::date
      AND (effective_to IS NULL OR effective_to >= $3::date)
    ORDER BY effective_from DESC, plan_id DESC
    LIMIT 1
    `,
    [st, bt, asOf]
  );
  return rows[0] || null;
}

export async function findRulesForPlan(planId, asOfDate = null, client = pool) {
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  const { rows } = await client.query(
    `
    SELECT *
    FROM pricing_rule
    WHERE plan_id = $1
      AND is_active = TRUE
      AND effective_from <= $2::date
      AND (effective_to IS NULL OR effective_to >= $2::date)
    ORDER BY priority DESC, rule_id ASC
    `,
    [planId, asOf]
  );
  return rows;
}

export async function listPlans({ serviceType, activeOnly = true } = {}) {
  const params = [];
  let where = " WHERE 1=1";
  if (serviceType) {
    params.push(String(serviceType).trim().toUpperCase());
    where += ` AND UPPER(service_type) = $${params.length}`;
  }
  if (activeOnly) where += " AND is_active = TRUE";

  const { rows } = await pool.query(
    `SELECT * FROM pricing_plan ${where} ORDER BY service_type, booking_type, code`,
    params
  );
  return rows;
}

/** Lifetime non-cancelled bookings (for 1st / every-6th promo). */
export async function countCustomerLifetimeBookings(customerId, client = pool) {
  const { rows } = await client.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM engagements e
    WHERE e.customerid = $1
      AND COALESCE(UPPER(e.engagement_status), '') NOT IN ('CANCELLED')
    `,
    [customerId]
  );
  return rows[0]?.cnt ?? 0;
}

/** Count non-cancelled maid/any engagements for customer on IST calendar day (for 6th-visit promo). */
export async function countCustomerBookingsOnIstDay(customerId, visitDate, client = pool) {
  const { rows } = await client.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM engagements e
    WHERE e.customerid = $1
      AND e.start_date = $2::date
      AND COALESCE(UPPER(e.engagement_status), '') NOT IN ('CANCELLED')
    `,
    [customerId, visitDate]
  );
  return rows[0]?.cnt ?? 0;
}

export async function insertQuoteLog({
  serviceType,
  bookingType,
  customerId,
  requestJson,
  responseJson,
  quotedTotal,
  client = pool,
}) {
  const { rows } = await client.query(
    `
    INSERT INTO pricing_quote_log (
      service_type, booking_type, customer_id,
      request_json, response_json, quoted_total
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
    RETURNING quote_id
    `,
    [
      serviceType,
      bookingType,
      customerId ?? null,
      JSON.stringify(requestJson),
      JSON.stringify(responseJson),
      quotedTotal,
    ]
  );
  return rows[0]?.quote_id;
}

export async function upsertPlan(plan, client = pool) {
  const { rows } = await client.query(
    `
    INSERT INTO pricing_plan (
      service_type, booking_type, code, name, unit,
      base_rate_min, base_rate_max, constraints_json,
      effective_from, effective_to, is_active
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::date,$10::date,$11)
    ON CONFLICT (service_type, booking_type, code) DO UPDATE SET
      name = EXCLUDED.name,
      unit = EXCLUDED.unit,
      base_rate_min = EXCLUDED.base_rate_min,
      base_rate_max = EXCLUDED.base_rate_max,
      constraints_json = EXCLUDED.constraints_json,
      effective_from = EXCLUDED.effective_from,
      effective_to = EXCLUDED.effective_to,
      is_active = EXCLUDED.is_active,
      updated_at = NOW()
    RETURNING *
    `,
    [
      plan.service_type,
      plan.booking_type,
      plan.code,
      plan.name,
      plan.unit,
      plan.base_rate_min,
      plan.base_rate_max,
      JSON.stringify(plan.constraints_json || {}),
      plan.effective_from || new Date().toISOString().slice(0, 10),
      plan.effective_to || null,
      plan.is_active !== false,
    ]
  );
  return rows[0];
}

export async function upsertRule(rule, client = pool) {
  if (rule.rule_id) {
    const { rows } = await client.query(
      `
      UPDATE pricing_rule SET
        rule_type = $2,
        priority = $3,
        condition_json = $4::jsonb,
        effect_json = $5::jsonb,
        effective_from = $6::date,
        effective_to = $7::date,
        is_active = $8,
        updated_at = NOW()
      WHERE rule_id = $1
      RETURNING *
      `,
      [
        rule.rule_id,
        rule.rule_type,
        rule.priority ?? 0,
        JSON.stringify(rule.condition_json || {}),
        JSON.stringify(rule.effect_json || {}),
        rule.effective_from || new Date().toISOString().slice(0, 10),
        rule.effective_to || null,
        rule.is_active !== false,
      ]
    );
    return rows[0];
  }

  const { rows } = await client.query(
    `
    INSERT INTO pricing_rule (
      plan_id, rule_type, priority, condition_json, effect_json,
      effective_from, effective_to, is_active
    )
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::date,$7::date,$8)
    RETURNING *
    `,
    [
      rule.plan_id,
      rule.rule_type,
      rule.priority ?? 0,
      JSON.stringify(rule.condition_json || {}),
      JSON.stringify(rule.effect_json || {}),
      rule.effective_from || new Date().toISOString().slice(0, 10),
      rule.effective_to || null,
      rule.is_active !== false,
    ]
  );
  return rows[0];
}

export { PG_IST_TODAY_DATE };
