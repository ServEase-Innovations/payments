import express from "express";
import {
  handlePostQuote,
  handleListPlans,
  handleGetPlanByBookingType,
} from "./pricing/pricingHandlers.js";

const router = express.Router();

/** @deprecated Use POST /api/v2/pricing/quote */
function deprecatedPricing(res) {
  res.set("Deprecation", "true");
  res.set("Sunset", "2026-12-31");
  res.set("Link", '</api/v2/pricing/quote>; rel="successor-version"');
}

router.post("/quote", (req, res) => {
  deprecatedPricing(res);
  return handlePostQuote(req, res);
});

/** @deprecated Use GET /api/v2/pricing/plans */
router.get("/plans", (req, res) => {
  deprecatedPricing(res);
  return handleListPlans(req, res);
});

/** @deprecated Use GET /api/v2/pricing/plans/:serviceType/:bookingType */
router.get("/plans/:serviceType/:bookingType", (req, res) => {
  deprecatedPricing(res);
  return handleGetPlanByBookingType(req, res);
});

export default router;
