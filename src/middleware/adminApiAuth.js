const DEV_ADMIN_SECRET = "serveaso-test-push-secret";

function resolveExpectedAdminSecret() {
  const fromEnv = (
    process.env.ADMIN_API_SECRET ||
    process.env.ADMIN_PUSH_SECRET ||
    process.env.INTERNAL_NOTIFY_SECRET ||
    process.env.ADMIN_TICKET_SECRET ||
    ""
  ).trim();
  if (fromEnv) {
    return fromEnv;
  }
  if ((process.env.NODE_ENV || "development") === "development") {
    return DEV_ADMIN_SECRET;
  }
  return "";
}

/** Protect /api/admin/* routes — header X-Admin-Push-Secret. */
export function requireAdminApiAuth(req, res, next) {
  const provided = String(
    req.headers["x-admin-push-secret"] || req.headers["x-admin-api-secret"] || ""
  ).trim();
  const expected = resolveExpectedAdminSecret();
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}
