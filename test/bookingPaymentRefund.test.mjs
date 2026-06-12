import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoCancelRefundNotificationBody,
  computeBookingRefundBreakdown,
  isRazorpayCapturedPaymentId,
} from "../src/services/bookingPaymentRefund.service.js";

describe("bookingPaymentRefund", () => {
  it("detects Razorpay captured payment ids", () => {
    assert.equal(isRazorpayCapturedPaymentId("pay_ABC123"), true);
    assert.equal(isRazorpayCapturedPaymentId("wallet_42_1710000000"), false);
    assert.equal(isRazorpayCapturedPaymentId(""), false);
  });

  it("splits wallet-only refunds", () => {
    const breakdown = computeBookingRefundBreakdown({
      total_amount: 500,
      wallet_amount: 500,
      wallet_deducted: true,
      transaction_id: "wallet_99_1710000000",
    });
    assert.equal(breakdown.walletRefund, 500);
    assert.equal(breakdown.razorpayRefund, 0);
    assert.equal(breakdown.razorpayPaymentId, null);
  });

  it("splits razorpay-only refunds", () => {
    const breakdown = computeBookingRefundBreakdown({
      total_amount: 750,
      wallet_amount: 0,
      wallet_deducted: false,
      transaction_id: "pay_RAZOR123",
    });
    assert.equal(breakdown.walletRefund, 0);
    assert.equal(breakdown.razorpayRefund, 750);
    assert.equal(breakdown.razorpayPaymentId, "pay_RAZOR123");
  });

  it("splits wallet + razorpay refunds", () => {
    const breakdown = computeBookingRefundBreakdown({
      total_amount: 1000,
      wallet_amount: 300,
      wallet_deducted: true,
      transaction_id: "pay_SPLIT123",
    });
    assert.equal(breakdown.walletRefund, 300);
    assert.equal(breakdown.razorpayRefund, 700);
    assert.equal(breakdown.razorpayPaymentId, "pay_SPLIT123");
  });

  it("builds wallet refund notification copy", () => {
    const body = buildAutoCancelRefundNotificationBody({
      walletRefund: 500,
      razorpayRefund: 0,
    });
    assert.match(body, /credited to your wallet/i);
    assert.doesNotMatch(body, /original payment method/i);
  });

  it("builds mixed refund notification copy", () => {
    const body = buildAutoCancelRefundNotificationBody({
      walletRefund: 200,
      razorpayRefund: 800,
    });
    assert.match(body, /credited to your wallet/i);
    assert.match(body, /original payment method/i);
  });
});
