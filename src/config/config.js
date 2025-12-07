import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Determine environment (local uses NODE_ENV)
const ENV = process.env.NODE_ENV || "development";

// Determine which .env file to load
let envPath;

// Priority #1 → EC2 uses ONLY `.env`
if (fs.existsSync(path.resolve(process.cwd(), ".env"))) {
  envPath = path.resolve(process.cwd(), ".env");
}
// Priority #2 → Local uses `.env.<env>`
else if (fs.existsSync(path.resolve(process.cwd(), `.env.${ENV}`))) {
  envPath = path.resolve(process.cwd(), `.env.${ENV}`);
}
// Priority #3 → fallback to `.env`
else {
  envPath = path.resolve(process.cwd(), ".env");
}

dotenv.config({ path: envPath });

console.log("Loaded env file:", envPath);

export default {
  env: ENV,
  postgres: {
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
    port: process.env.POSTGRES_PORT || 5432,
  },
  mongo: {
    uri: process.env.MONGO_URI,
  },
};
