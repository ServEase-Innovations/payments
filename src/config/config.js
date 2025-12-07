import dotenv from "dotenv";
import path from "path";

// Load correct .env file based on NODE_ENV
const env = process.env.NODE_ENV || "development";

dotenv.config({
  path: path.resolve(process.cwd(), `.env.${env}`)
});

export default {
  env,
  postgres: {
    host: process.env.POSTGRES_HOST || '127.0.0.1',
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  port: process.env.POSTGRES_PORT || 5432,
  },
  mongo: {
    uri: process.env.MONGO_URI
  }
};
