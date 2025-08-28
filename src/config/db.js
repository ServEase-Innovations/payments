import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  user: "serveaso",
  host: "13.126.11.184",
  database: "serveaso",
  password: "serveaso",
  port: 5432,
});

export default pool;