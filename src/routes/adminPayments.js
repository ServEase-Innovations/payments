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

/**
 * GET /api/admin/ledger
 * Admin – Serveaso Ledger
 */
router.get("/ledger", async (req, res) => {
  try {
    const { from, to, limit = 50, offset = 0 } = req.query;

    const params = [];
    let where = "";

    // ---- Date filters ----
    if (from) {
      params.push(from);
      where += ` AND created_at::date >= $${params.length}`;
    }

    if (to) {
      params.push(to);
      where += ` AND created_at::date <= $${params.length}`;
    }

    // ---- 1️⃣ Payments (CREDIT) ----
    const paymentsQuery = `
      SELECT
        created_at::date AS date,
        'PAYMENT' AS type,
        transaction_id AS reference,
        engagement_id,
        0::numeric AS debit,
        total_amount::numeric AS credit,
        'Customer payment' AS note,
        created_at
      FROM payments
      WHERE status = 'SUCCESS'
      ${where}
    `;

    // ---- 2️⃣ Provider payouts (DEBIT) ----
    const payoutsQuery = `
      SELECT
        created_at::date AS date,
        'PAYOUT' AS type,
        payout_id::text AS reference,
        engagement_id,
        net_amount::numeric AS debit,
        0::numeric AS credit,
        'Provider payout' AS note,
        created_at
      FROM payouts
      WHERE status = 'SUCCESS'
      ${where}
    `;

    // ---- 3️⃣ Ledger rows ----
    const ledgerQuery = `
      SELECT * FROM (
        ${paymentsQuery}
        UNION ALL
        ${payoutsQuery}
      ) l
      ORDER BY created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const ledgerParams = [...params, Number(limit), Number(offset)];
    const { rows } = await pool.query(ledgerQuery, ledgerParams);

    // ---- 4️⃣ Running balance (page-level) ----
    let balance = 0;
    const ledger = rows
      .slice()
      .reverse()
      .map((r) => {
        balance += Number(r.credit) - Number(r.debit);
        return { ...r, balance };
      })
      .reverse();

    // ---- 5️⃣ Summary (FULL, matches UI) ----
    const summaryQuery = `
      SELECT
        COALESCE(pay.total_collected, 0)       AS total_collected,
        COALESCE(pay.platform_fee, 0)          AS platform_revenue,
        COALESCE(pay.gst, 0)                    AS gst_payable,
        COALESCE(pout.provider_payouts, 0)     AS provider_payouts,
        0                                      AS refunds,
        (
          COALESCE(pay.total_collected, 0)
          - COALESCE(pout.provider_payouts, 0)
        )                                      AS net_balance
      FROM
        (
          SELECT
            SUM(total_amount) AS total_collected,
            SUM(platform_fee) AS platform_fee,
            SUM(gst) AS gst
          FROM payments
          WHERE status='SUCCESS'
          ${where}
        ) pay
      LEFT JOIN
        (
          SELECT
            SUM(net_amount) AS provider_payouts
          FROM payouts
          WHERE status='SUCCESS'
          ${where}
        ) pout ON true
    `;

    const summaryRes = await pool.query(summaryQuery, params);

    // ---- Response ----
    res.json({
      success: true,
      summary: summaryRes.rows[0],
      ledger,
      count: ledger.length,
    });

  } catch (err) {
    console.error("Admin ledger error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});













export default router;