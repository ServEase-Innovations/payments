import pg from "pg";
import config from "../config/config.js";

const { Pool } = pg;

const pool = new Pool({
  host: config.postgres.host,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  port: config.postgres.port,
});

pool.query("SELECT current_database(), current_schema();")
  .then(res => console.log(res.rows))
  .catch(err => console.error(err));

export default pool;