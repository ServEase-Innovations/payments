import pg from "pg";
import config from "../config/config.js";

const { Pool } = pg;

const pool = new Pool({
  host: config.postgres.host,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  port: config.postgres.port,
  max: config.postgres.poolMax,
  idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
  connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
  keepAlive: true,
});

// Required: idle clients that hit network/server timeouts emit "error" on the pool.
// Without this listener, Node treats it as unhandled and exits.
pool.on("error", (err, _client) => {
  console.error("[postgres pool] idle client error:", err?.message || err, err?.code || "");
});

console.log(
  `[postgres] pool → ${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`
);

pool
  .query("SELECT current_database(), current_schema();")
  .then((res) => console.log("[postgres] connected:", res.rows[0]))
  .catch((err) =>
    console.error(
      `[postgres] initial connect failed (${err?.code || err?.message}). ` +
        "Unread in-app notifications will return empty until POSTGRES_HOST is reachable."
    )
  );

export default pool;