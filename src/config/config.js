import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { syncPostgresDbAliases, requirePostgresDatabaseName } = require("../../../../scripts/postgres-env.cjs");

const ENV = process.env.NODE_ENV || "development";

// EC2 will always have only `.env` because GitHub writes it.
// Local will load `.env.<env>` if available.
let envPath = path.resolve(process.cwd(), `.env.${ENV}`);

// If env file does not exist (EC2), fallback to `.env`
if (!fs.existsSync(envPath)) {
  envPath = path.resolve(process.cwd(), ".env");
}

dotenv.config({ path: envPath });

syncPostgresDbAliases(process.env);

console.log("✔ Loaded env file:", envPath);

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
