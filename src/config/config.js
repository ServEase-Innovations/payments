import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadPostgresEnvHelpers() {
  const candidates = [
    path.resolve(__dirname, "../../../../scripts/postgres-env.cjs"),
    path.resolve(__dirname, "../../../scripts/postgres-env.cjs"),
    path.resolve(process.cwd(), "scripts/postgres-env.cjs"),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return require(filePath);
    }
  }

  function parseDatabaseFromUrl(url) {
    if (!url || !String(url).trim()) return undefined;
    try {
      const u = new URL(String(url).trim());
      const name = decodeURIComponent(u.pathname.replace(/^\//, "").split("?")[0] || "");
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  function syncPostgresDbAliases(env = process.env) {
    const fromUrl = parseDatabaseFromUrl(env.DATABASE_URL);
    const db =
      fromUrl ||
      (env.POSTGRES_DB && String(env.POSTGRES_DB).trim()) ||
      (env.DB_NAME && String(env.DB_NAME).trim()) ||
      undefined;
    if (!db) return undefined;
    if (fromUrl) {
      if (!env.POSTGRES_DB?.trim()) env.POSTGRES_DB = db;
      if (!env.DB_NAME?.trim()) env.DB_NAME = db;
    } else if (env.POSTGRES_DB?.trim()) {
      if (!env.DB_NAME?.trim()) env.DB_NAME = String(env.POSTGRES_DB).trim();
    } else if (env.DB_NAME?.trim()) {
      if (!env.POSTGRES_DB?.trim()) env.POSTGRES_DB = String(env.DB_NAME).trim();
    }
    return db;
  }

  function requirePostgresDatabaseName(env = process.env) {
    const db = syncPostgresDbAliases(env);
    if (!db) {
      throw new Error(
        "Postgres database name not configured. Set DATABASE_URL, POSTGRES_DB, or DB_NAME in Render Environment."
      );
    }
    return db;
  }

  return { syncPostgresDbAliases, requirePostgresDatabaseName };
}

const { syncPostgresDbAliases, requirePostgresDatabaseName } = loadPostgresEnvHelpers();

const ENV = process.env.NODE_ENV || "development";

// EC2 will always have only `.env` because GitHub writes it.
// Local will load `.env.<env>` if available.
let envPath = path.resolve(process.cwd(), `.env.${ENV}`);

// If env file does not exist (EC2), fallback to `.env`
if (!fs.existsSync(envPath)) {
  envPath = path.resolve(process.cwd(), ".env");
}

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log("✔ Loaded env file:", envPath);
} else {
  console.warn(
    `[payments] no .env file at ${path.resolve(process.cwd(), `.env.${ENV}`)} or .env — ` +
      "using process env (Render dashboard / shell)."
  );
}

syncPostgresDbAliases(process.env);

export default {
  env: ENV,
  couponsServiceUrl:
    process.env.COUPONS_SERVICE_URL || "http://localhost:3002",
  postgres: {
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: requirePostgresDatabaseName(process.env),
    port: process.env.POSTGRES_PORT || 5432,
    poolMax: Number(process.env.POSTGRES_POOL_MAX) || 10,
    poolIdleTimeoutMs: Number(process.env.POSTGRES_POOL_IDLE_TIMEOUT_MS) || 60_000,
    poolConnectionTimeoutMs:
      Number(process.env.POSTGRES_POOL_CONNECTION_TIMEOUT_MS) || 10_000,
  },
  mongo: {
    uri: process.env.MONGO_URI,
  },
};
