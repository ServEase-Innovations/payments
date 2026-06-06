/** Dev-only defaults that must never be active when NODE_ENV=production */
export const FORBIDDEN_PRODUCTION_SECRETS = new Set([
  "serveaso-test-push-secret",
  "change-me-in-production",
  "change-me",
]);

const FORBIDDEN_RAZORPAY_KEY_ID = "rzp_test_lTdgjtSRlEwreA";
const FORBIDDEN_RAZORPAY_KEY_SECRET = "g15WB8CEwaYBQ5FqpIKKMdNS";

function assertProductionEnv(name, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error(`${name} is required when NODE_ENV=production`);
  }
  if (FORBIDDEN_PRODUCTION_SECRETS.has(trimmed)) {
    throw new Error(`${name} must not use a dev/default value in production`);
  }
  return trimmed;
}

/**
 * Fail fast at startup if production is misconfigured (S4).
 * Call once after loading config / .env.
 */
export function validatePaymentsProductionSecrets() {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const internalSecret = (
    process.env.INTERNAL_NOTIFY_SECRET ||
    process.env.ADMIN_PUSH_SECRET ||
    process.env.ADMIN_TICKET_SECRET ||
    ""
  ).trim();
  assertProductionEnv(
    "INTERNAL_NOTIFY_SECRET or ADMIN_PUSH_SECRET or ADMIN_TICKET_SECRET",
    internalSecret
  );

  assertProductionEnv("RAZORPAY_WEBHOOK_SECRET", process.env.RAZORPAY_WEBHOOK_SECRET);

  const keySecret = (
    process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET || ""
  ).trim();
  if (!keySecret || keySecret === FORBIDDEN_RAZORPAY_KEY_SECRET) {
    throw new Error(
      "RAZORPAY_KEY_SECRET (or RAZORPAY_SECRET) is required in production — do not rely on code defaults"
    );
  }

  const keyId = (process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY || "").trim();
  if (!keyId || keyId === FORBIDDEN_RAZORPAY_KEY_ID) {
    throw new Error(
      "RAZORPAY_KEY_ID (or RAZORPAY_KEY) is required in production — do not rely on code defaults"
    );
  }

  if (process.env.SKIP_RAZORPAY_WEBHOOK_VERIFY === "true") {
    throw new Error("SKIP_RAZORPAY_WEBHOOK_VERIFY must not be true in production");
  }
  if (process.env.SKIP_RAZORPAY_VERIFY === "true") {
    throw new Error("SKIP_RAZORPAY_VERIFY must not be true in production");
  }
}
