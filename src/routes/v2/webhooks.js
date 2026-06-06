import express from "express";
import { handleRazorpayPaymentWebhook } from "../../services/razorpayWebhook.service.js";

const router = express.Router();

/**
 * Legacy/alternate mount path. Canonical Razorpay URL:
 * POST /api/v2/createEngagements/webhook
 */
router.post("/webhook", handleRazorpayPaymentWebhook);

export default router;
