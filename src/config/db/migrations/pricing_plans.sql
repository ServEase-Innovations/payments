-- Maid (and future services) configurable rate card — idempotent

CREATE TABLE IF NOT EXISTS pricing_plan (
  plan_id           BIGSERIAL PRIMARY KEY,
  service_type      VARCHAR(50) NOT NULL,
  booking_type      VARCHAR(50) NOT NULL,
  code              VARCHAR(80) NOT NULL,
  name              VARCHAR(200) NOT NULL,
  unit              VARCHAR(20) NOT NULL,
  base_rate_min     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  base_rate_max     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  constraints_json  JSONB NOT NULL DEFAULT '{}',
  effective_from    DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to      DATE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_type, booking_type, code)
);

CREATE INDEX IF NOT EXISTS idx_pricing_plan_lookup
  ON pricing_plan (service_type, booking_type, is_active, effective_from);

CREATE TABLE IF NOT EXISTS pricing_rule (
  rule_id           BIGSERIAL PRIMARY KEY,
  plan_id           BIGINT NOT NULL REFERENCES pricing_plan(plan_id) ON DELETE CASCADE,
  rule_type         VARCHAR(50) NOT NULL,
  priority          INT NOT NULL DEFAULT 0,
  condition_json    JSONB NOT NULL DEFAULT '{}',
  effect_json       JSONB NOT NULL DEFAULT '{}',
  effective_from    DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to      DATE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_rule_plan
  ON pricing_rule (plan_id, is_active, priority DESC);

-- Optional audit of quotes attached to bookings (engagements also store snapshot in responsibilities)
CREATE TABLE IF NOT EXISTS pricing_quote_log (
  quote_id          BIGSERIAL PRIMARY KEY,
  service_type      VARCHAR(50) NOT NULL,
  booking_type      VARCHAR(50) NOT NULL,
  customer_id       BIGINT,
  request_json      JSONB NOT NULL,
  response_json     JSONB NOT NULL,
  quoted_total      NUMERIC(12, 2) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Seed MAID rate card (ON_DEMAND hourly, SHORT_TERM daily, MONTHLY) ----------
INSERT INTO pricing_plan (
  service_type, booking_type, code, name, unit,
  base_rate_min, base_rate_max, constraints_json, is_active
) VALUES
  (
    'MAID', 'ON_DEMAND', 'MAID_HOURLY',
    'Maid — hourly on demand', 'HOUR',
    150, 200,
    '{
      "hourlyMin": 150,
      "hourlyMax": 200,
      "promoHourlyRate": 99,
      "promoEveryN": 6,
      "fullDayRateMin": 720,
      "fullDayRateMax": 950,
      "fullDayHoursMin": 6,
      "fullDayHoursMax": 8
    }'::jsonb,
    TRUE
  ),
  (
    'MAID', 'SHORT_TERM', 'MAID_DAILY_ST',
    'Maid — short term (daily, max 15 days)', 'DAY',
    7350, 9800,
    '{
      "hoursPerDay": 1,
      "visitHoursDefault": 1,
      "hoursPerDayMin": 1,
      "hoursPerDayMax": 8,
      "maxDurationDays": 15,
      "sevenDayPkgMin": 1050,
      "sevenDayPkgMax": 1400,
      "hourlyBaseMin": 1050,
      "hourlyBaseMax": 1400,
      "disc8to15DaysPct": 25,
      "incrementalBaselineHours": 1,
      "incrementalHourDiscountPct": 5
    }'::jsonb,
    TRUE
  ),
  (
    'MAID', 'MONTHLY', 'MAID_MONTHLY',
    'Maid — monthly contract', 'MONTH',
    3999, 5999,
    '{
      "visitHoursDefault": 2,
      "incrementalHourDiscountPct": 5,
      "hourlyDiscMin": 850,
      "hourlyDiscMax": 1150,
      "daysPerMonth": 26
    }'::jsonb,
    TRUE
  )
ON CONFLICT (service_type, booking_type, code) DO UPDATE SET
  name = EXCLUDED.name,
  unit = EXCLUDED.unit,
  base_rate_min = EXCLUDED.base_rate_min,
  base_rate_max = EXCLUDED.base_rate_max,
  constraints_json = EXCLUDED.constraints_json,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- Rules: hourly
INSERT INTO pricing_rule (plan_id, rule_type, priority, condition_json, effect_json, is_active)
SELECT p.plan_id, v.rule_type, v.priority, v.condition_json::jsonb, v.effect_json::jsonb, TRUE
FROM pricing_plan p
CROSS JOIN (VALUES
  ('FIXED_RATE', 10, '{"kind":"FIRST_BOOKING_LIFETIME"}', '{"amount":99,"unit":"HOUR"}'),
  ('NTH_BOOKING_LIFETIME', 30, '{"kind":"NTH_BOOKING_LIFETIME","n":6}', '{"amount":99,"unit":"HOUR"}'),
  ('FIXED_DAY_PACKAGE', 25, '{"kind":"FULL_DAY_HOURS","hoursMin":6,"hoursMax":8}', '{"amountMin":720,"amountMax":950,"unit":"DAY"}')
) AS v(rule_type, priority, condition_json, effect_json)
WHERE p.code = 'MAID_HOURLY'
  AND NOT EXISTS (
    SELECT 1 FROM pricing_rule r
    WHERE r.plan_id = p.plan_id AND r.rule_type = v.rule_type
      AND r.condition_json = v.condition_json::jsonb
  );

-- Deactivate legacy on-demand rules (promo applied to every visit)
UPDATE pricing_rule r
SET is_active = FALSE, updated_at = NOW()
FROM pricing_plan p
WHERE r.plan_id = p.plan_id
  AND p.code = 'MAID_HOURLY'
  AND (
    r.condition_json->>'kind' = 'DEFAULT_PROMO'
    OR r.condition_json->>'kind' = 'NTH_BOOKING_SAME_DAY_IST'
  );

-- Rules: short term
INSERT INTO pricing_rule (plan_id, rule_type, priority, condition_json, effect_json, is_active)
SELECT p.plan_id, v.rule_type, v.priority, v.condition_json::jsonb, v.effect_json::jsonb, TRUE
FROM pricing_plan p
CROSS JOIN (VALUES
  ('PERCENT_OFF', 20, '{"durationDaysMin":7,"durationDaysMax":7}', '{"percent":20,"displayHourlyMin":850,"displayHourlyMax":1150}'),
  ('PERCENT_OFF', 25, '{"durationDaysMin":8,"durationDaysMax":15}', '{"percent":25,"displayHourlyMin":850,"displayHourlyMax":1150}'),
  ('FIXED_PACKAGE', 15, '{"hours":2}', '{"amountMin":1499,"amountMax":2099}'),
  ('INCREMENTAL_HOUR_DISCOUNT', 12, '{"fromHour":3}', '{"percent":5}')
) AS v(rule_type, priority, condition_json, effect_json)
WHERE p.code = 'MAID_DAILY_ST'
  AND NOT EXISTS (
    SELECT 1 FROM pricing_rule r
    WHERE r.plan_id = p.plan_id AND r.rule_type = v.rule_type
      AND r.condition_json = v.condition_json::jsonb
  );
