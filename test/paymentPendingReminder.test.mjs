import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePaymentPendingPolicy,
  resolveDuePaymentReminderTier,
  DEFAULT_PAYMENT_REMINDER_POLICY,
} from "../src/services/paymentPendingReminderPolicy.js";

test("parsePaymentPendingPolicy uses defaults when missing", () => {
  const policy = parsePaymentPendingPolicy({});
  assert.deepEqual(
    policy.paymentPendingOffsetsMinutes,
    DEFAULT_PAYMENT_REMINDER_POLICY.paymentPendingOffsetsMinutes
  );
  assert.equal(
    policy.paymentPendingExpiryMinutes,
    DEFAULT_PAYMENT_REMINDER_POLICY.paymentPendingExpiryMinutes
  );
});

test("parsePaymentPendingPolicy sorts and dedupes offsets", () => {
  const policy = parsePaymentPendingPolicy({
    customerReminders: {
      paymentPendingOffsetsMinutes: [120, 15, 15, 60, 240],
    },
  });
  assert.deepEqual(policy.paymentPendingOffsetsMinutes, [15, 60, 120, 240]);
});

test("resolveDuePaymentReminderTier picks first unsent due tier", () => {
  const offsets = [15, 60, 180];
  assert.equal(resolveDuePaymentReminderTier(10, offsets, new Set()), null);
  assert.equal(resolveDuePaymentReminderTier(20, offsets, new Set()), 15);
  assert.equal(resolveDuePaymentReminderTier(20, offsets, new Set([15])), null);
  assert.equal(resolveDuePaymentReminderTier(90, offsets, new Set([15])), 60);
  assert.equal(
    resolveDuePaymentReminderTier(200, offsets, new Set([15, 60])),
    180
  );
  assert.equal(
    resolveDuePaymentReminderTier(500, offsets, new Set([15, 60, 180])),
    null
  );
});
