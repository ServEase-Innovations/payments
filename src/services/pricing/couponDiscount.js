const COUPONS_BASE = String(
  process.env.COUPONS_SERVICE_URL || "http://localhost:3002"
).replace(/\/$/, "");

/**
 * Preview coupon discount via coupons service (no reservation).
 * @returns {Promise<{ coupon_code: string, coupon_id: string, discount_amount: number, final_amount: number }>}
 */
export async function validateCouponForQuote({
  couponCode,
  customerId,
  orderValue,
  serviceType,
  city,
}) {
  const code = String(couponCode || "").trim().toUpperCase();
  if (!code) return null;

  const customer_id = Number(customerId);
  if (!Number.isFinite(customer_id) || customer_id < 1) {
    const err = new Error("customerId is required to apply a coupon");
    err.status = 400;
    throw err;
  }

  const order_value = Number(orderValue);
  if (!Number.isFinite(order_value) || order_value <= 0) {
    const err = new Error("Order value must be greater than zero to apply a coupon");
    err.status = 400;
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  let res;
  try {
    res = await fetch(`${COUPONS_BASE}/api/coupons/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coupon_code: code,
        customer_id,
        order_value,
        service_type: serviceType ? String(serviceType).trim().toUpperCase() : undefined,
        city: city ? String(city).trim() : undefined,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const e = new Error(
      err?.name === "AbortError"
        ? "Coupons service timed out"
        : err?.message || "Could not reach coupons service"
    );
    e.status = 503;
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.message || json?.debugMessage || "Coupon could not be applied");
    e.status = res.status >= 400 && res.status < 500 ? res.status : 400;
    throw e;
  }

  const data = json?.data ?? json;
  const discount_amount = Number(data?.discount_amount);
  if (!Number.isFinite(discount_amount) || discount_amount < 0) {
    throw new Error("Invalid coupon discount from coupons service");
  }

  return {
    coupon_code: data.coupon_code || code,
    coupon_id: data.coupon_id,
    discount_amount,
    final_amount: Number(data.final_amount),
  };
}
