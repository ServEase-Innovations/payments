import express from "express";
import pool from "../config/db.js";
import { requireAdminApiAuth } from "../middleware/adminApiAuth.js";
import {
  listPlans,
  findRulesForPlan,
  upsertPlan,
  upsertRule,
} from "../services/pricing/pricingRepository.js";

const router = express.Router();

router.use(requireAdminApiAuth);

router.get("/pricing/plans", async (req, res) => {
  try {
    const plans = await listPlans({
      serviceType: req.query.serviceType || req.query.service_type,
      activeOnly: req.query.activeOnly !== "false",
    });
    const withRules = await Promise.all(
      plans.map(async (p) => ({
        ...p,
        rules: await findRulesForPlan(p.plan_id),
      }))
    );
    res.json({ success: true, plans: withRules });
  } catch (err) {
    console.error("admin pricing plans:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/pricing/plans", async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    await client.query("BEGIN");
    const plan = await upsertPlan(body, client);
    await client.query("COMMIT");
    res.json({ success: true, plan });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("admin upsert plan:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.put("/pricing/rules", async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.plan_id && !body.rule_id) {
      return res.status(400).json({ success: false, error: "plan_id required for new rules" });
    }
    await client.query("BEGIN");
    const rule = await upsertRule(body, client);
    await client.query("COMMIT");
    res.json({ success: true, rule });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("admin upsert rule:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.patch("/pricing/plans/:planId/active", async (req, res) => {
  try {
    const { is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE pricing_plan SET is_active = $2, updated_at = NOW() WHERE plan_id = $1 RETURNING *`,
      [req.params.planId, is_active !== false]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Plan not found" });
    res.json({ success: true, plan: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
