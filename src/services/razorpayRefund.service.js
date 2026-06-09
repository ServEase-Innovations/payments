import { razorpay } from "../utils/razorpayConfig.js";

/**
 * Issue a full Razorpay refund for a captured payment.
 * @returns {Promise<{ id: string, amount: number, status?: string }>}
 */
export async function refundRazorpayPaymentFull({
  razorpayPaymentId,
  amountInr,
  notes = {},
}) {
  const paymentId = String(razorpayPaymentId || "").trim();
  if (!paymentId) {
    throw new Error("Missing Razorpay payment id for refund");
  }

  const inr = Number(amountInr);
  if (!Number.isFinite(inr) || inr <= 0) {
    throw new Error("Invalid refund amount");
  }

  const amountPaise = Math.round(inr * 100);
  const refund = await razorpay.payments.refund(paymentId, {
    amount: amountPaise,
    notes,
  });

  return {
    id: refund?.id,
    amount: refund?.amount != null ? Number(refund.amount) : amountPaise,
    status: refund?.status,
  };
}
