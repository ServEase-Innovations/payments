import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "servease",
  password: "yourpassword",
  port: 5432,
});

export default pool;