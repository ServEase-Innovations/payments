import { expressjwt } from "express-jwt";
import jwksRsa from "jwks-rsa";

const DEV_ADMIN_SECRET = "serveaso-test-push-secret";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const PUBLIC_MUTATION_PREFIXES = [
  "/api/v2/createEngagements/webhook",
  "/api/internal/",
  "/api/admin/",
];

const PUBLIC_MUTATION_EXACT = new Set([
  "/api/pricing/quote",
  "/api/v2/pricing/quote",
  "/api/v2/service-providers/nearby-monthly",
]);

export function isAuthConfigured() {
  return Boolean(
    process.env.AUTH0_DOMAIN?.trim() && process.env.AUTH0_AUDIENCE?.trim()
  );
}

function shouldProtectMutations() {
  if (process.env.JWT_PROTECT_MUTATIONS === "false") {
    return false;
  }
  if (process.env.JWT_PROTECT_MUTATIONS === "true") {
    return isAuthConfigured();
  }
  return isProduction() && isAuthConfigured();
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

let checkJwtMiddleware = null;

export function getCheckJwt() {
  if (!checkJwtMiddleware && isAuthConfigured()) {
    checkJwtMiddleware = expressjwt({
      secret: jwksRsa.expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
      }),
      audience: process.env.AUTH0_AUDIENCE,
      issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      algorithms: ["RS256"],
    });
  }
  return checkJwtMiddleware;
}

function resolveExpectedServiceSecret() {
  return (
    process.env.INTERNAL_NOTIFY_SECRET ||
    process.env.ADMIN_PUSH_SECRET ||
    process.env.ADMIN_TICKET_SECRET ||
    ""
  ).trim();
}

export function hasValidBypassSecret(req) {
  const expected = resolveExpectedServiceSecret();
  const adminProvided = String(
    req.headers["x-admin-push-secret"] || req.headers["x-admin-api-secret"] || ""
  ).trim();
  const internalProvided = String(req.headers["x-internal-secret"] || "").trim();

  if (expected && (adminProvided === expected || internalProvided === expected)) {
    return true;
  }
  if (!isProduction() && adminProvided === DEV_ADMIN_SECRET) {
    return true;
  }
  return false;
}

function normalizePath(req) {
  return (req.originalUrl || req.url || req.path || "").split("?")[0];
}

function isPublicMutation(req) {
  const path = normalizePath(req);
  if (SAFE_METHODS.has(req.method)) {
    return true;
  }
  if (
    path === "/health" ||
    path === "/ready" ||
    path === "/metrics" ||
    path.startsWith("/v1/api-docs") ||
    path.startsWith("/v2/api-docs")
  ) {
    return true;
  }
  if (PUBLIC_MUTATION_EXACT.has(path)) {
    return true;
  }
  return PUBLIC_MUTATION_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Require Auth0 JWT on mutating routes unless explicitly public or service-secret bypass. */
export function requireJwtOnMutations(req, res, next) {
  if (!shouldProtectMutations()) {
    return next();
  }
  if (isPublicMutation(req)) {
    return next();
  }
  if (hasValidBypassSecret(req)) {
    return next();
  }

  const checkJwt = getCheckJwt();
  if (!checkJwt) {
    return next();
  }
  return checkJwt(req, res, next);
}
