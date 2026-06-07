import crypto from "crypto";

const ISSUER = "serveaso-session";

export function getSessionJwtSecret() {
  return (
    process.env.SESSION_JWT_SECRET?.trim() ||
    process.env.INTERNAL_NOTIFY_SECRET?.trim() ||
    process.env.ADMIN_PUSH_SECRET?.trim() ||
    ""
  );
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** HS256 session JWT for phone OTP login (shared with providers service). */
export function signServeasoSessionToken(payload, ttlSeconds = 60 * 60 * 24 * 7) {
  const secret = getSessionJwtSecret();
  if (!secret) {
    throw new Error("SESSION_JWT_SECRET (or INTERNAL_NOTIFY_SECRET) is not configured");
  }
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64urlJson({
    iss: ISSUER,
    iat: now,
    exp: now + ttlSeconds,
    ...payload,
  });
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyServeasoSessionToken(token) {
  const secret = getSessionJwtSecret();
  if (!secret || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.iss !== ISSUER) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  if (!raw.startsWith("Bearer ")) return null;
  const token = raw.slice(7).trim();
  return token || null;
}
