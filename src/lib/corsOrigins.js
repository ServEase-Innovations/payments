/** @typedef {{ origin: boolean | string[], methods: string[], credentials: boolean }} SocketIoCorsConfig */

export function parseCorsOrigins() {
  const raw =
    process.env.CORS_ORIGINS ||
    process.env.ALLOWED_ORIGINS ||
    process.env.APP_URL ||
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSocketIoOrigins() {
  const socketRaw = process.env.SOCKET_IO_ORIGINS || "";
  const socketList = socketRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (socketList.length > 0) {
    return socketList;
  }
  return parseCorsOrigins();
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

/**
 * @param {string[]} allowedOrigins
 */
export function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) {
    return true;
  }
  if (allowedOrigins.length === 0) {
    return !isProduction();
  }
  return allowedOrigins.includes(origin) || allowedOrigins.includes("*");
}

/**
 * @param {string[]} allowedOrigins
 */
export function corsOriginCallback(allowedOrigins) {
  return (origin, cb) => {
    if (isOriginAllowed(origin, allowedOrigins)) {
      return cb(null, true);
    }
    return cb(null, false);
  };
}

/** @returns {SocketIoCorsConfig} */
export function getSocketIoCorsConfig() {
  const allowedOrigins = parseSocketIoOrigins();
  if (allowedOrigins.length === 0) {
    return {
      origin: !isProduction(),
      methods: ["GET", "POST"],
      credentials: true,
    };
  }
  return {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  };
}

export function assertCorsOriginsProduction() {
  if (!isProduction()) {
    return;
  }
  const origins = parseCorsOrigins();
  if (origins.length === 0) {
    throw new Error(
      "CORS_ORIGINS is required when NODE_ENV=production (comma-separated web/mobile origins)"
    );
  }
}
