import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyRazorpayWebhookSignature } from "../src/utils/razorpayWebhookHmac.js";

describe("verifyRazorpayWebhookSignature", () => {
  it("returns true for matching HMAC", () => {
    const raw = '{"event":"payment.captured"}';
    const secret = "whsec_test";
    const sig = createHmac("sha256", secret).update(raw).digest("hex");
    assert.equal(verifyRazorpayWebhookSignature(raw, sig, secret), true);
  });

  it("returns false when signature or secret is wrong", () => {
    const raw = '{"event":"payment.captured"}';
    assert.equal(verifyRazorpayWebhookSignature(raw, "nope", "whsec_test"), false);
    assert.equal(verifyRazorpayWebhookSignature(raw, "", "whsec_test"), false);
    assert.equal(verifyRazorpayWebhookSignature("", "sig", "whsec_test"), false);
  });
});
