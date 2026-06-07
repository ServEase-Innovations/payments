import pool from "../config/db.js";
import {
  getCheckJwt,
  hasValidBypassSecret,
  isAuthConfigured,
  isProduction,
} from "./checkJwt.js";
import {
  getSessionJwtSecret,
  parseBearerToken,
  verifyServeasoSessionToken,
} from "../utils/sessionToken.js";

export function isReadProtectionEnabled() {
  if (process.env.JWT_PROTECT_READS === "false") return false;
  if (process.env.JWT_PROTECT_READS === "true") return true;
  return isProduction();
}

function emptyActor() {
  return { customerIds: [], providerIds: [], isAdmin: false };
}

function pushId(set, value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && !set.includes(n)) set.push(n);
}

function extractEmail(auth) {
  if (!auth || typeof auth !== "object") return null;
  return (
    auth.email ||
    auth["https://serveaso.com/email"] ||
    auth["https://servease.com/email"] ||
    null
  );
}

async function lookupIdsByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return { customerIds: [], providerIds: [] };
  const [cRes, pRes] = await Promise.all([
    pool.query(
      `SELECT customerid FROM customer WHERE LOWER(TRIM(emailid)) = $1`,
      [norm]
    ),
    pool.query(
      `SELECT serviceproviderid FROM serviceprovider WHERE LOWER(TRIM(emailid)) = $1`,
      [norm]
    ),
  ]);
  return {
    customerIds: cRes.rows.map((r) => Number(r.customerid)).filter((n) => n > 0),
    providerIds: pRes.rows
      .map((r) => Number(r.serviceproviderid))
      .filter((n) => n > 0),
  };
}

function applySessionClaims(actor, session) {
  if (!session) return;
  if (session.role) actor.role = session.role;
  pushId(actor.customerIds, session.customerId ?? session.customerid);
  pushId(actor.providerIds, session.serviceProviderId ?? session.serviceproviderid);
}

function applyAuth0Claims(actor, auth) {
  if (!auth) return;
  pushId(actor.customerIds, auth.customerId ?? auth.customerid);
  pushId(
    actor.providerIds,
    auth.serviceProviderId ?? auth.serviceproviderid ?? auth.service_provider_id
  );
}

/** Validate Bearer: Serveaso session JWT or Auth0 access token. */
export function authenticateRead(req, res, next) {
  if (!isReadProtectionEnabled()) return next();
  if (hasValidBypassSecret(req)) {
    req.actor = { ...emptyActor(), isAdmin: true };
    return next();
  }

  const bearer = parseBearerToken(req);
  if (!bearer) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const session = verifyServeasoSessionToken(bearer);
  if (session) {
    req.actor = emptyActor();
    applySessionClaims(req.actor, session);
    return next();
  }

  const checkJwt = getCheckJwt();
  if (!checkJwt) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  return checkJwt(req, res, (err) => {
    if (err) return next(err);
    return next();
  });
}

/** Resolve customer/provider ids from session JWT or Auth0 email claims. */
export async function loadActor(req, res, next) {
  if (!isReadProtectionEnabled()) return next();
  if (req.actor?.isAdmin) return next();

  if (!req.actor) req.actor = emptyActor();

  const bearer = parseBearerToken(req);
  const session = bearer ? verifyServeasoSessionToken(bearer) : null;
  if (session) {
    applySessionClaims(req.actor, session);
    return next();
  }

  if (req.auth) {
    applyAuth0Claims(req.actor, req.auth);
    const email = extractEmail(req.auth);
    if (email) {
      const ids = await lookupIdsByEmail(email);
      ids.customerIds.forEach((id) => pushId(req.actor.customerIds, id));
      ids.providerIds.forEach((id) => pushId(req.actor.providerIds, id));
    }
  }

  return next();
}

export function requireAdminRead(req, res, next) {
  if (!isReadProtectionEnabled()) return next();
  if (req.actor?.isAdmin) return next();
  return res.status(403).json({ error: "Forbidden" });
}

export function requireOwnCustomerId(paramName = "customerId") {
  return (req, res, next) => {
    if (!isReadProtectionEnabled()) return next();
    if (req.actor?.isAdmin) return next();
    const id = Number(req.params[paramName]);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ error: "Invalid customer id" });
    }
    if (!req.actor?.customerIds?.includes(id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

export function requireOwnProviderId(paramName = "providerId") {
  return (req, res, next) => {
    if (!isReadProtectionEnabled()) return next();
    if (req.actor?.isAdmin) return next();
    const id = Number(req.params[paramName]);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ error: "Invalid provider id" });
    }
    if (!req.actor?.providerIds?.includes(id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

export function requireEngagementParticipant(paramName = "id") {
  return async (req, res, next) => {
    if (!isReadProtectionEnabled()) return next();
    if (req.actor?.isAdmin) return next();

    const raw =
      req.params[paramName] ??
      req.params.engagementId ??
      req.params.id;
    const id = Number(raw);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ error: "Invalid engagement id" });
    }

    try {
      const r = await pool.query(
        `SELECT customerid, serviceproviderid FROM engagements WHERE engagement_id = $1`,
        [id]
      );
      if (!r.rows.length) {
        return res.status(404).json({ error: "Engagement not found" });
      }
      const customerid = Number(r.rows[0].customerid);
      const serviceproviderid =
        r.rows[0].serviceproviderid != null
          ? Number(r.rows[0].serviceproviderid)
          : null;
      const okCustomer = req.actor?.customerIds?.includes(customerid);
      const okProvider =
        serviceproviderid != null &&
        req.actor?.providerIds?.includes(serviceproviderid);
      if (!okCustomer && !okProvider) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return next();
    } catch (err) {
      console.error("requireEngagementParticipant", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export function requireEngagementCustomer(paramName = "engagementId") {
  return async (req, res, next) => {
    if (!isReadProtectionEnabled()) return next();
    if (req.actor?.isAdmin) return next();

    const id = Number(req.params[paramName]);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ error: "Invalid engagement id" });
    }

    try {
      const r = await pool.query(
        `SELECT customerid FROM engagements WHERE engagement_id = $1`,
        [id]
      );
      if (!r.rows.length) {
        return res.status(404).json({ error: "Engagement not found" });
      }
      const customerid = Number(r.rows[0].customerid);
      if (!req.actor?.customerIds?.includes(customerid)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return next();
    } catch (err) {
      console.error("requireEngagementCustomer", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export function requireNotificationRecipient(req, res, next) {
  if (!isReadProtectionEnabled()) return next();
  if (req.actor?.isAdmin) return next();

  const q = req.query && typeof req.query === "object" ? req.query : {};
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const merged = { ...q, ...b };
  const recipientType = String(
    merged.recipientType || merged.recipient_type || ""
  ).toLowerCase();
  const recipientId = Number(merged.recipientId ?? merged.recipient_id);

  if (recipientType === "customer") {
    if (!req.actor?.customerIds?.includes(recipientId)) {
      return res.status(403).json({ error: "Forbidden" });
    }
  } else if (recipientType === "provider") {
    if (!req.actor?.providerIds?.includes(recipientId)) {
      return res.status(403).json({ error: "Forbidden" });
    }
  } else {
    return res.status(400).json({ error: "recipientType must be customer or provider" });
  }
  return next();
}

export function isSessionAuthAvailable() {
  return Boolean(getSessionJwtSecret()) || isAuthConfigured();
}
