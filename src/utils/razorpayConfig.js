import Razorpay from "razorpay";

/** Public key id for Checkout (must match the account that created the order). */
export function getRazorpayKeyId() {
  return (
    process.env.RAZORPAY_KEY ||
    process.env.RAZORPAY_KEY_ID ||
    "rzp_test_lTdgjtSRlEwreA"
  );
}

export function getRazorpayKeySecret() {
  return (
    process.env.RAZORPAY_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    "g15WB8CEwaYBQ5FqpIKKMdNS"
  );
}

export const razorpay = new Razorpay({
  key_id: getRazorpayKeyId(),
  key_secret: getRazorpayKeySecret(),
});
