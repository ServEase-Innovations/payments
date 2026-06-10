import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePaymentPendingPolicy,
  isEligibleForPaymentTimeoutExpiry,
  DEFAULT_PAYMENT_REMINDER_POLICY,
} from "../src/services/paymentPendingReminderPolicy.js";

test("parsePaymentPendingPolicy includes payment expiry minutes default", () => {
  const policy = parsePaymentPendingPolicy({});
  assert.equal(
    policy.paymentPendingExpiryMinutes,
    DEFAULT_PAYMENT_REMINDER_POLICY.paymentPendingExpiryMinutes
  );
});

test("parsePaymentPendingPolicy reads custom expiry minutes", () => {
  const policy = parsePaymentPendingPolicy({
    customerReminders: {
      paymentPendingExpiryMinutes: 30,
    },
  });
  assert.equal(policy.paymentPendingExpiryMinutes, 30);
});

test("isEligibleForPaymentTimeoutExpiry requires pending payment and age", () => {
  const engagement = {
    engagement_status: "PAYMENT_PENDING",
    task_status: "NOT_STARTED",
  };
  const payment = { status: "PENDING" };

  assert.equal(isEligibleForPaymentTimeoutExpiry(engagement, payment, 19, 20), false);
  assert.equal(isEligibleForPaymentTimeoutExpiry(engagement, payment, 20, 20), true);
  assert.equal(isEligibleForPaymentTimeoutExpiry(engagement, payment, 25, 20), true);
  assert.equal(
    isEligibleForPaymentTimeoutExpiry(
      { ...engagement, engagement_status: "ASSIGNED" },
      payment,
      25,
      20
    ),
    false
  );
  assert.equal(
    isEligibleForPaymentTimeoutExpiry(engagement, { status: "SUCCESS" }, 25, 20),
    false
  );
});
