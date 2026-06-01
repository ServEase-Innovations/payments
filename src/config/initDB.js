/**
 * Payments no longer applies DDL on startup.
 * Run migrations from https://github.com/ServEase-Innovations/DB_Migrations
 * (monorepo: npm run db:migrate)
 */
async function initDB() {
  if (process.env.RUN_DB_MIGRATIONS === "true") {
    console.warn(
      "⚠️  RUN_DB_MIGRATIONS=true is deprecated for payments. Use DB_Migrations: npm run db:migrate"
    );
  }
}

export default initDB;
