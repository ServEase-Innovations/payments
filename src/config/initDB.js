import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDB() {
  // Correct path: src/db/schema.sql
  const schemaPath = path.join(__dirname, "db", "schema.sql");

  try {
    console.log("📁 Loading schema from:", schemaPath);
    const schemaSQL = fs.readFileSync(schemaPath, "utf8");
    console.log("⏳ Applying database schema...");
    await pool.query(schemaSQL);
    console.log("✅ Database schema applied successfully!");
  } catch (err) {
    console.error("❌ Error applying database schema:", err);
  }

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
}

export default initDB;
