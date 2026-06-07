import cors from "cors";
import {
  corsOriginCallback,
  parseCorsOrigins,
} from "../lib/corsOrigins.js";

const allowedOrigins = parseCorsOrigins();

export const corsMiddleware = cors({
  origin: corsOriginCallback(allowedOrigins),
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "X-Admin-Push-Secret",
    "X-Admin-Api-Secret",
    "X-Internal-Secret",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
});

export { allowedOrigins };
