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
    host: process.env.PG_HOST,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DB,
  },
  mongo: {
    uri: process.env.MONGO_URI
  }
};
