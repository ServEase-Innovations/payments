import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDB() {
  // Correct path: src/db/schema.sql
  const schemaPath = path.join(__dirname, "db", "schema.sql");

  // Some environments never pick up the tail of `schema.sql` (transaction/ordering).
  // This idempotent pass guarantees `in_app_notifications` exists when the app starts.
  try {
    const migrationPath = path.join(
      __dirname,
      "db",
      "migrations",
      "in_app_notifications.sql"
    );
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, "utf8");
      await pool.query(sql);
      console.log("✅ in_app_notifications table ensured");
    }
  } catch (err) {
    console.error("❌ in_app_notifications migration failed:", err);
  }

  try {
    const pricingPath = path.join(__dirname, "db", "migrations", "pricing_plans.sql");
    if (fs.existsSync(pricingPath)) {
      const sql = fs.readFileSync(pricingPath, "utf8");
      await pool.query(sql);
      console.log("✅ pricing_plan / pricing_rule tables ensured");
    }
  } catch (err) {
    console.error("❌ pricing_plans migration failed:", err);
  }

  try {
    const statusPath = path.join(
      __dirname,
      "db",
      "migrations",
      "engagement_status_check.sql"
    );
    if (fs.existsSync(statusPath)) {
      const sql = fs.readFileSync(statusPath, "utf8");
      await pool.query(sql);
      console.log("✅ engagements_engagement_status_check updated for V2 statuses");
    }
  } catch (err) {
    console.error("❌ engagement_status_check migration failed:", err);
  }
}

export default initDB;
