/**
 * S11 — Role-safe API response shaping (payment + cross-role PII).
 */

const PAYMENT_CUSTOMER_FIELDS = new Set([
  "engagement_id",
  "base_amount",
  "platform_fee",
  "gst",
  "total_amount",
  "payment_mode",
  "status",
  "created_at",
]);

const PROVIDER_ENGAGEMENT_STRIP = new Set([
  "customer_email",
  "emailid",
  "email",
  "customer_emailid",
  "emailId",
]);

const CUSTOMER_ENGAGEMENT_STRIP = new Set([
  "razorpay_order_id",
  "transaction_id",
  "payment_id",
]);

function omitKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

export function redactPaymentForCustomer(payment) {
  if (!payment || typeof payment !== "object") return null;
  const out = {};
  for (const k of PAYMENT_CUSTOMER_FIELDS) {
    if (payment[k] !== undefined) out[k] = payment[k];
  }
  return Object.keys(out).length ? out : null;
}

export function redactPaymentVerifyResponse(payment) {
  return redactPaymentForCustomer(payment);
}

/** Provider-facing engagement: contact name/phone + service location; no customer email. */
export function redactEngagementForProvider(engagement) {
  if (!engagement || typeof engagement !== "object") return engagement;
  let out = omitKeys(engagement, PROVIDER_ENGAGEMENT_STRIP);
  if (out.customer && typeof out.customer === "object") {
    const { email, emailid, emailId, ...customerSafe } = out.customer;
    out = { ...out, customer: customerSafe };
  }
  return out;
}

/** Customer-facing engagement: own booking + safe payment summary. */
export function redactEngagementForCustomer(engagement) {
  if (!engagement || typeof engagement !== "object") return engagement;
  let out = omitKeys(engagement, CUSTOMER_ENGAGEMENT_STRIP);
  if (out.payment) {
    out = { ...out, payment: redactPaymentForCustomer(out.payment) };
  }
  if (out.provider && typeof out.provider === "object") {
    const p = out.provider;
    out = {
      ...out,
      provider: {
        serviceproviderid: p.serviceproviderid ?? p.serviceProviderId,
        firstName: p.firstName ?? p.firstname,
        lastName: p.lastName ?? p.lastname,
        rating: p.rating ?? null,
      },
    };
  }
  return out;
}

/** Razorpay resume checkout payload — no internal payment_id in response. */
export function buildResumeCheckoutResponse({
  razorpay_order_id,
  razorpay_key_id,
  amount,
  amount_inr,
  currency,
  engagement_id,
  booking_type,
  service_type,
  status,
  created_at,
  customer,
}) {
  return {
    success: true,
    razorpay_order_id,
    razorpay_key_id,
    amount,
    amount_inr,
    currency,
    engagement_id,
    engagementId: engagement_id,
    booking_type,
    service_type,
    status,
    created_at,
    customer: customer
      ? {
          customerid: customer.customerid,
          firstname: customer.firstname,
          lastname: customer.lastname,
          contact: customer.contact ?? customer.mobile ?? customer.mobileno,
          email: customer.email ?? customer.emailid,
        }
      : undefined,
  };
}
