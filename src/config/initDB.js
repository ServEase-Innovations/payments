import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDB() {
  try {
    // Correct path: src/db/schema.sql
    const schemaPath = path.join(__dirname, "db", "schema.sql");

    console.log("📁 Loading schema from:", schemaPath);

    const schemaSQL = fs.readFileSync(schemaPath, "utf8");

    console.log("⏳ Applying database schema...");

    await pool.query(schemaSQL);

    console.log("✅ Database schema applied successfully!");
  } catch (err) {
    console.error("❌ Error applying database schema:", err);
  }
}

export default initDB;
