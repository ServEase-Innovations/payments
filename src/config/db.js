import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  user: "serveaso",
  host: "18.60.51.140",
  database: "serveaso",
  password: "serveaso",
  port: 5432,
});

export default pool;