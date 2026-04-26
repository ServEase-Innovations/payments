/**
 * Resolves the OpenAPI 3 `servers[0].url` for the Payments API.
 * Route paths in the spec are like `/engagements/...` — the server base must end
 * in `/api` to align with `app.use("/api/...", ...)` in `index.js`.
 *
 * 1) If `SWAGGER_SERVER_URL` / `APP_URL` / `BASE_URL` / `PUBLIC_URL` is set, it is
 *    used (a trailing `/api` is added when missing). Good for a fixed public URL.
 * 2) Otherwise: current request’s scheme + host (`X-Forwarded-*` when
 *    `app.set("trust proxy", ...)` is enabled).
 */
export function getPaymentsOpenApiServerUrl(req) {
  const fromEnv = pickEnvBaseUrl();
  if (fromEnv) {
    return ensureApiSuffix(stripTrail(fromEnv));
  }
  if (!req || typeof req.get !== "function") {
    return "http://localhost:4000/api";
  }
  const host = (req.get("X-Forwarded-Host") || req.get("Host") || "localhost")
    .split(",")[0]
    .trim();
  const proto = (req.get("X-Forwarded-Proto") || req.protocol || "http")
    .toString()
    .split(",")[0]
    .trim();
  return `${proto}://${host}/api`;
}

function pickEnvBaseUrl() {
  for (const key of ["SWAGGER_SERVER_URL", "APP_URL", "BASE_URL", "PUBLIC_URL"]) {
    const v = process.env[key];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

function stripTrail(s) {
  return s.replace(/\/+$/, "");
}

function ensureApiSuffix(base) {
  if (base.endsWith("/api")) return base;
  return `${base}/api`;
}
