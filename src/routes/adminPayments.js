import express from "express";
import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

router.get("/payments/summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_transactions,
        SUM(total_amount) AS total_collected,
        SUM(platform_fee) AS platform_fee,
        SUM(gst) AS gst,
        SUM(platform_fee - gst) AS net_revenue
      FROM payments
      WHERE status = 'SUCCESS'
    `);

    res.json({
      success: true,
      summary: result.rows[0],
    });
  } catch (err) {
    console.error("Payment summary error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/payments", async (req , res ) => {
  try {
    const {
      status,
      payment_mode,
      from,
      to,
      engagement_id,
      limit = 20,
      offset = 0,
    } = req.query;

    let query = `
      SELECT
        p.*,
        e.booking_type,
        e.service_type,
        c.firstname AS customer_firstname,
        c.lastname AS customer_lastname,
        sp.firstname AS provider_firstname,
        sp.lastname AS provider_lastname
      FROM payments p
      JOIN engagements e ON e.engagement_id = p.engagement_id
      JOIN customer c ON c.customerid = e.customerid
      LEFT JOIN serviceprovider sp ON sp.serviceproviderid = e.serviceproviderid
      WHERE 1=1
    `;

    const params = [];
    let idx = 1;

    if (status) {
      query += ` AND p.status = $${idx++}`;
      params.push(status);
    }

    if (payment_mode) {
      query += ` AND p.payment_mode = $${idx++}`;
      params.push(payment_mode);
    }

    if (engagement_id) {
      query += ` AND p.engagement_id = $${idx++}`;
      params.push(engagement_id);
    }

    if (from) {
      query += ` AND p.created_at >= $${idx++}`;
      params.push(from);
    }

    if (to) {
      query += ` AND p.created_at <= $${idx++}`;
      params.push(to);
    }

    query += `
      ORDER BY p.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      payments: result.rows,
    });
  } catch (err) {
    console.error("Admin payments error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


router.get("/payments/:paymentId", async (req, res) => {
  try {
    const { paymentId } = req.params;

    const result = await pool.query(
      `
      SELECT
        p.*,
        e.booking_type,
        e.service_type,
        e.start_date,
        e.end_date,
        c.firstname AS customer_firstname,
        c.lastname AS customer_lastname,
        c.mobileno,
        sp.firstname AS provider_firstname,
        sp.lastname AS provider_lastname
      FROM payments p
      JOIN engagements e ON e.engagement_id = p.engagement_id
      JOIN customer c ON c.customerid = e.customerid
      LEFT JOIN serviceprovider sp ON sp.serviceproviderid = e.serviceproviderid
      WHERE p.payment_id = $1
      `,
      [paymentId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Payment not found" });

    res.json({ success: true, payment: result.rows[0] });
  } catch (err) {
    console.error("Admin payment detail error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});











export default router;