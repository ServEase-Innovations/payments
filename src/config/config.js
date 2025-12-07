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
    host: process.env.host,
    user: process.env.user,
    password: process.env.password,
    database: process.env.database,
    port: process.env.port
  },
  mongo: {
    uri: process.env.MONGO_URI
  }
};
