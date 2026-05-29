import express from "express";
import config from "../config/config.js";

const router = express.Router();

/**
 * Proxy customer coupon list to coupons service (used by mobile clients on payments base URL).
 * GET /api/coupons/customer/:customer_id?serviceType=COOK|MAID
 */
router.get("/coupons/customer/:customer_id", async (req, res) => {
  const base = String(config.couponsServiceUrl || "http://localhost:3002").replace(
    /\/$/,
    ""
  );
  const customerId = encodeURIComponent(req.params.customer_id);
  const qs = new URLSearchParams();
  const serviceType = req.query.serviceType || req.query.service_type;
  if (serviceType) qs.set("serviceType", String(serviceType));

  const url = `${base}/api/coupons/customer/${customerId}${
    qs.size ? `?${qs.toString()}` : ""
  }`;

  try {
    const upstream = await fetch(url, { headers: { Accept: "application/json" } });
    const json = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(json);
  } catch (err) {
    console.error("[coupons proxy] customer list failed:", err?.message || err);
    return res.status(503).json({
      success: false,
      message: "Coupons service unavailable",
    });
  }
});

export default router;
