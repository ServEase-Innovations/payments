import {
  creditWalletForBookingRefund,
  roundInr,
} from "./customerWallet.service.js";
import { refundRazorpayPaymentFull } from "./razorpayRefund.service.js";

export function isRazorpayCapturedPaymentId(transactionId) {
  return String(transactionId || "").trim().startsWith("pay_");
}

/**
 * Split a successful booking payment into wallet vs Razorpay refund amounts.
 * Under Option 1: 100% of the refund goes back to the customer's wallet.
 * If deductPlatformFee is true (user-initiated cancellation), we subtract the platform_fee.
 */
export function computeBookingRefundBreakdown(payment, deductPlatformFee = false) {
  const total = roundInr(payment?.total_amount ?? 0);
  const platformFee = deductPlatformFee ? roundInr(payment?.platform_fee ?? 0) : 0;
  const refundAmount = Math.max(0, roundInr(total - platformFee));

  return {
    total: refundAmount,
    walletRefund: refundAmount,
    razorpayRefund: 0,
    razorpayPaymentId: null,
  };
}

export function buildAutoCancelRefundNotificationBody({
  walletRefund = 0,
  razorpayRefund = 0,
} = {}) {
  const intro =
    "We could not assign a service professional before your scheduled start time. " +
    "Your booking has been cancelled.";

  const walletInr = roundInr(walletRefund);
  const razorpayInr = roundInr(razorpayRefund);
  const parts = [];

  if (walletInr > 0) {
    parts.push(`₹${walletInr.toFixed(2)} has been credited to your wallet`);
  }
  if (razorpayInr > 0) {
    parts.push(
      `₹${razorpayInr.toFixed(2)} will be refunded to your original payment method ` +
        "(typically within 5–7 business days)"
    );
  }

  if (!parts.length) {
    return `${intro} No payment was collected for this booking.`;
  }

  return `${intro} ${parts.join(". ")}.`;
}

/**
 * Refund a paid booking to the customer's wallet and/or Razorpay as applicable.
 */
export async function refundPaidBookingToCustomer(
  client,
  {
    payment,
    customerId,
    engagementId,
    refundDescription,
    deductPlatformFee = false,
    razorpayNotes = {},
  }
) {
  const breakdown = computeBookingRefundBreakdown(payment, deductPlatformFee);

  if (breakdown.walletRefund <= 0 && breakdown.razorpayRefund <= 0) {
    const err = new Error("No refundable amount for this payment");
    err.statusCode = 400;
    throw err;
  }

  let walletBalanceAfter = null;
  if (breakdown.walletRefund > 0) {
    walletBalanceAfter = await creditWalletForBookingRefund(client, {
      customerId,
      engagementId,
      amount: breakdown.walletRefund,
      description: refundDescription,
    });
  }

  let razorpayRefundResult = null;
  if (breakdown.razorpayRefund > 0 && breakdown.razorpayPaymentId) {
    // Under Option 1, razorpayRefund is 0, so this block is bypassed.
    // If needed in the future, it is preserved here.
    async function performRazorpayRefund() {
      const { refundRazorpayPaymentFull } = await import("./razorpayRefund.service.js");
      return refundRazorpayPaymentFull({
        razorpayPaymentId: breakdown.razorpayPaymentId,
        amountInr: breakdown.razorpayRefund,
        notes: {
          engagement_id: String(engagementId),
          ...razorpayNotes,
        },
      });
    }
    razorpayRefundResult = await performRazorpayRefund();
  }

  return {
    ...breakdown,
    walletBalanceAfter,
    razorpayRefundId: razorpayRefundResult?.id ?? null,
  };
}
