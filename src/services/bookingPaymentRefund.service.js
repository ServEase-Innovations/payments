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
 */
export function computeBookingRefundBreakdown(payment) {
  const total = roundInr(payment?.total_amount ?? 0);
  const walletAmount = roundInr(payment?.wallet_amount ?? 0);
  const walletDeducted = Boolean(payment?.wallet_deducted) && walletAmount > 0;
  const walletRefund = walletDeducted ? Math.min(walletAmount, total) : 0;

  const razorpayPaymentId = isRazorpayCapturedPaymentId(payment?.transaction_id)
    ? String(payment.transaction_id).trim()
    : null;
  const razorpayRefund =
    razorpayPaymentId && walletRefund < total ? roundInr(total - walletRefund) : 0;

  return {
    total,
    walletRefund,
    razorpayRefund,
    razorpayPaymentId,
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
    razorpayNotes = {},
  }
) {
  const breakdown = computeBookingRefundBreakdown(payment);

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
    razorpayRefundResult = await refundRazorpayPaymentFull({
      razorpayPaymentId: breakdown.razorpayPaymentId,
      amountInr: breakdown.razorpayRefund,
      notes: {
        engagement_id: String(engagementId),
        ...razorpayNotes,
      },
    });
  }

  return {
    ...breakdown,
    walletBalanceAfter,
    razorpayRefundId: razorpayRefundResult?.id ?? null,
  };
}
