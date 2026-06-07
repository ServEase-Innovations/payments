import express from "express";
import pool from "../config/db.js";

const router = express.Router();

router.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "payments",
    uptime: process.uptime(),
  });
});

router.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ready", service: "payments" });
  } catch (err) {
    res.status(503).json({
      status: "not_ready",
      service: "payments",
      error: err?.message || "database unreachable",
    });
  }
});

export default router;
