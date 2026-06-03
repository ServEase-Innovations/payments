/**
 * Shared Postgres env resolution for the Serveaso monorepo.
 *
 * Canonical database name (pick one):
 *   - POSTGRES_DB  (preferred)
 *   - DB_NAME      (Sequelize / legacy alias — synced from POSTGRES_DB)
 *   - DATABASE_URL path segment (wins when set)
 *
 * Local dev: set POSTGRES_DB once in repo-root `.env.local` (see `.env.local.example`).
 */
const fs = require("fs");
const path = require("path");

function tryLoadDotenv() {
  try {
    return require("dotenv");
  } catch {
    return null;
  }
}

function parseDatabaseFromUrl(url) {
  if (!url || !String(url).trim()) return undefined;
  try {
    const u = new URL(String(url).trim());
    const name = decodeURIComponent(u.pathname.replace(/^\//, "").split("?")[0] || "");
    return name || undefined;
  } catch {
    return undefined;
  }
}

function findMonorepoRoot(fromDir = process.cwd()) {
  let d = path.resolve(fromDir);
  while (d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json")) && fs.existsSync(path.join(d, "services"))) {
      return d;
    }
    d = path.dirname(d);
  }
  return null;
}

/** Load repo-root env files without overriding vars already set in the shell. */
function loadMonorepoPostgresEnv(options = {}) {
  const root = options.root || findMonorepoRoot(options.fromDir);
  if (!root) return { root: null, loaded: [] };

  const loaded = [];
  const dotenv = tryLoadDotenv();
  if (!dotenv) {
    syncPostgresDbAliases(process.env);
    return { root, loaded };
  }
  for (const name of [".env.local", ".env.monorepo", ".env"]) {
    const filePath = path.join(root, name);
    if (!fs.existsSync(filePath)) continue;
    dotenv.config({ path: filePath, override: false });
    loaded.push(filePath);
  }
  syncPostgresDbAliases(process.env);
  return { root, loaded };
}

/**
 * Resolve database name from env. Does not mutate env.
 * @returns {string | undefined}
 */
function resolvePostgresDatabaseName(env = process.env) {
  return (
    parseDatabaseFromUrl(env.DATABASE_URL) ||
    (env.POSTGRES_DB && String(env.POSTGRES_DB).trim()) ||
    (env.DB_NAME && String(env.DB_NAME).trim()) ||
    undefined
  );
}

/** Mirror POSTGRES_DB ↔ DB_NAME so all services see the same database name. */
function syncPostgresDbAliases(env = process.env) {
  const fromUrl = parseDatabaseFromUrl(env.DATABASE_URL);
  const db =
    fromUrl ||
    (env.POSTGRES_DB && String(env.POSTGRES_DB).trim()) ||
    (env.DB_NAME && String(env.DB_NAME).trim()) ||
    undefined;

  if (!db) return undefined;

  if (fromUrl) {
    if (!env.POSTGRES_DB?.trim()) env.POSTGRES_DB = db;
    if (!env.DB_NAME?.trim()) env.DB_NAME = db;
  } else if (env.POSTGRES_DB?.trim()) {
    if (!env.DB_NAME?.trim()) env.DB_NAME = String(env.POSTGRES_DB).trim();
  } else if (env.DB_NAME?.trim()) {
    if (!env.POSTGRES_DB?.trim()) env.POSTGRES_DB = String(env.DB_NAME).trim();
  }

  return db;
}

function requirePostgresDatabaseName(env = process.env) {
  const db = syncPostgresDbAliases(env);
  if (!db) {
    throw new Error(
      "Postgres database name not configured. Set POSTGRES_DB (preferred), DB_NAME, or DATABASE_URL " +
        "with a database path. For local dev, copy .env.local.example → .env.local at the monorepo root."
    );
  }
  return db;
}

function buildDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL?.trim()) return env.DATABASE_URL.trim();

  const database = requirePostgresDatabaseName(env);
  const host = env.POSTGRES_HOST || env.DB_HOST || "127.0.0.1";
  const port = env.POSTGRES_PORT || env.DB_PORT || "5432";
  const user = env.POSTGRES_USER || env.DB_USER;
  const password = env.POSTGRES_PASSWORD ?? env.DB_PASSWORD ?? "";

  if (!user) {
    throw new Error(
      "Postgres user not configured. Set POSTGRES_USER or DB_USER (and POSTGRES_DB / DATABASE_URL)."
    );
  }

  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(password);
  return `postgresql://${encUser}:${encPass}@${host}:${port}/${encodeURIComponent(database)}`;
}

module.exports = {
  parseDatabaseFromUrl,
  findMonorepoRoot,
  loadMonorepoPostgresEnv,
  resolvePostgresDatabaseName,
  syncPostgresDbAliases,
  requirePostgresDatabaseName,
  buildDatabaseUrl,
};
