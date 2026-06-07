import pool from "../config/db.js";
import { handlePaymentSuccess } from "./paymentLifecycle.service.js";
import { verifyRazorpayWebhookSignature } from "../utils/razorpayWebhookHmac.js";

export { verifyRazorpayWebhookSignature };

export function isRazorpayWebhookVerifySkipped() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SKIP_RAZORPAY_WEBHOOK_VERIFY === "true"
  );
}

async function resolveEngagementIdForOrder(razorpayOrderId, paymentEntity) {
  const paymentRes = await pool.query(
    `SELECT engagement_id FROM payments WHERE razorpay_order_id = $1 LIMIT 1`,
    [razorpayOrderId]
  );
  if (paymentRes.rows.length) {
    return Number(paymentRes.rows[0].engagement_id);
  }

  const fromNotes =
    paymentEntity?.notes?.engagementId ?? paymentEntity?.notes?.engagement_id;
  const parsed = Number(fromNotes);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Razorpay payment.captured webhook — signature required in production.
 * Canonical path: POST /api/v2/createEngagements/webhook
 */
export async function handleRazorpayPaymentWebhook(req, res) {
  const signature = req.headers["x-razorpay-signature"];
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();

  if (!isRazorpayWebhookVerifySkipped()) {
    if (!webhookSecret) {
      console.error("RAZORPAY_WEBHOOK_SECRET is not set");
      return res.status(503).json({ error: "Webhook verification is not configured" });
    }
    if (!req.rawBody || !signature) {
      return res.status(400).json({ error: "Missing webhook signature or body" });
    }
    if (!verifyRazorpayWebhookSignature(req.rawBody, signature, webhookSecret)) {
      console.error("Invalid Razorpay webhook signature");
      return res.status(400).json({ error: "Invalid signature" });
    }
  } else {
    console.warn(
      "⚠️ SKIP_RAZORPAY_WEBHOOK_VERIFY=true — webhook signature check disabled (dev only)"
    );
  }

  try {
    const event =
      req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)
        ? req.body
        : JSON.parse(req.rawBody?.toString() || "{}");

    if (event.event !== "payment.captured") {
      return res.status(200).json({ received: true });
    }

    const paymentEntity = event.payload?.payment?.entity;
    if (!paymentEntity?.order_id || !paymentEntity?.id) {
      return res.status(400).json({ error: "Invalid payment.captured payload" });
    }

    const engagementId = await resolveEngagementIdForOrder(
      paymentEntity.order_id,
      paymentEntity
    );
    if (!engagementId) {
      return res.status(404).json({ error: "Payment / engagement not found for order" });
    }

    const result = await handlePaymentSuccess({
      engagementId,
      razorpay_order_id: paymentEntity.order_id,
      razorpay_payment_id: paymentEntity.id,
      rawEvent: event,
      io: req.io,
    });

    if (result?.alreadyProcessed) {
      return res.status(200).json({ received: true, message: "Already processed" });
    }

    return res.status(200).json({ success: true, received: true });
  } catch (err) {
    console.error("Razorpay webhook error:", err);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
