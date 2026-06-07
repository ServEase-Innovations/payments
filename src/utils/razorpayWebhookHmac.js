import { createHmac } from "crypto";

export function verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret) {
  if (!rawBody || !signature || !webhookSecret) {
    return false;
  }
  const expectedSignature = createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  return expectedSignature === signature;
}
