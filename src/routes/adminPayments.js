import express from "express";
import pool from "../config/db.js";
import { requireAdminApiAuth } from "../middleware/adminApiAuth.js";
import {
  listActiveVacationPriorityEngagements,
  listPendingOnDemandForVacationWindow,
} from "../services/vacationPriority.service.js";
import {
  adminSetProviderQueue,
  fetchQueuesForEngagements,
} from "../services/onDemandProviderQueue.service.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

router.use(requireAdminApiAuth);

function toFiniteEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function isoFromEpoch(epochSeconds) {
  const ep = toFiniteEpoch(epochSeconds);
  if (ep == null) return null;
  return new Date(ep * 1000).toISOString();
}

function ymdFromEpoch(epochSeconds) {
  const ep = toFiniteEpoch(epochSeconds);
  if (ep == null) return null;
  return dayjs.unix(ep).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

router.get("/payments/summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS')::bigint AS success_count,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'FAILED')::bigint AS failed_count,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) NOT IN ('SUCCESS', 'FAILED'))::bigint AS open_count,
        COUNT(*)::bigint AS total_all,
        COALESCE(SUM(total_amount) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'), 0) AS total_collected,
        COALESCE(SUM(platform_fee) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'), 0) AS platform_fee,
        COALESCE(SUM(gst) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'), 0) AS gst,
        COALESCE(SUM((platform_fee - gst)) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'), 0) AS net_revenue
      FROM payments
    `);

    const row = result.rows[0] || {};
    // Backward-compatible alias: successful tx count (same as old "total_transactions" for SUCCESS-only list)
    row.total_transactions = row.success_count;

    res.json({
      success: true,
      summary: row,
    });
  } catch (err) {
    console.error("Payment summary error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const paymentsListFrom = `
  FROM payments p
  JOIN engagements e ON e.engagement_id = p.engagement_id
  JOIN customer c ON c.customerid = e.customerid
  LEFT JOIN serviceprovider sp ON sp.serviceproviderid = e.serviceproviderid
`;

function buildAdminPaymentsFilters(query, startIdx) {
  const { status, payment_mode, from, to, from_epoch, to_epoch, engagement_id } = query;
  let where = " WHERE 1=1";
  const params = [];
  let idx = startIdx;
  const resolvedFrom = from || isoFromEpoch(from_epoch);
  const resolvedTo = to || isoFromEpoch(to_epoch);

  if (status) {
    where += ` AND p.status = $${idx++}`;
    params.push(status);
  }
  if (payment_mode) {
    where += ` AND p.payment_mode = $${idx++}`;
    params.push(payment_mode);
  }
  if (engagement_id) {
    where += ` AND p.engagement_id = $${idx++}`;
    params.push(engagement_id);
  }
  if (resolvedFrom) {
    where += ` AND p.created_at >= $${idx++}`;
    params.push(resolvedFrom);
  }
  if (resolvedTo) {
    where += ` AND p.created_at <= $${idx++}`;
    params.push(resolvedTo);
  }
  return { where, params, nextIdx: idx };
}

/**
 * GET /api/admin/payments
 * Filters:
 * - Legacy: from, to (ISO/date-time)
 * - Epoch-first aliases: from_epoch, to_epoch (unix seconds)
 */
router.get("/payments", async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const lim = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 200);
    const off = Math.max(Number.parseInt(String(offset), 10) || 0, 0);

    const { where, params, nextIdx } = buildAdminPaymentsFilters(req.query, 1);
    const countQ = `SELECT COUNT(*)::bigint AS total ${paymentsListFrom} ${where}`;
    const countRes = await pool.query(countQ, params);
    const total = Number(countRes.rows[0]?.total) || 0;

    const listQ = `
      SELECT
        p.*,
        e.booking_type,
        e.service_type,
        c.firstname AS customer_firstname,
        c.lastname AS customer_lastname,
        sp.firstname AS provider_firstname,
        sp.lastname AS provider_lastname
      ${paymentsListFrom}
      ${where}
      ORDER BY p.created_at DESC
      LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
    `;
    const listParams = [...params, lim, off];
    const result = await pool.query(listQ, listParams);

    res.json({
      success: true,
      total,
      count: result.rows.length,
      limit: lim,
      offset: off,
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
 * Filters:
 * - Legacy: from, to (YYYY-MM-DD)
 * - Epoch-first aliases: from_epoch, to_epoch (unix seconds)
 */
router.get("/ledger", async (req, res) => {
  try {
    const { from, to, from_epoch, to_epoch, limit = 50, offset = 0 } = req.query;
    const resolvedFrom = from || ymdFromEpoch(from_epoch);
    const resolvedTo = to || ymdFromEpoch(to_epoch);

    const params = [];
    let where = "";

    // ---- Date filters ----
    if (resolvedFrom) {
      params.push(resolvedFrom);
      where += ` AND created_at::date >= $${params.length}`;
    }

    if (resolvedTo) {
      params.push(resolvedTo);
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

    // Total row count (same filter scope, for admin UI pagination)
    const countQuery = `
      SELECT COUNT(*)::bigint AS c FROM (
        ${paymentsQuery}
        UNION ALL
        ${payoutsQuery}
      ) t
    `;
    const { rows: countRows } = await pool.query(countQuery, params);
    const total = Math.max(0, Number(countRows[0]?.c || 0));

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
      total,
    });

  } catch (err) {
    console.error("Admin ledger error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});


/**
 * GET /api/admin/engagements
 * Filters:
 * - Legacy: from, to (YYYY-MM-DD bounds over start_date/end_date)
 * - Epoch-first aliases: start_date_epoch, end_date_epoch (unix seconds)
 */
router.get("/engagements", async (req, res) => {
  try {
    const {
      booking_type,
      service_type,
      assignment_status,
      task_status,
      active,
      from,
      to,
      start_date_epoch,
      end_date_epoch,
      crm_escalated,
      engagement_status,
      limit = 200,
      offset = 0,
    } = req.query;
    const resolvedFrom = from || ymdFromEpoch(start_date_epoch);
    const resolvedTo = to || ymdFromEpoch(end_date_epoch);

    const params = [];
    let where = "WHERE 1=1";
    const lim = Math.min(Math.max(Number.parseInt(String(limit), 10) || 200, 1), 2000);
    const off = Math.max(Number.parseInt(String(offset), 10) || 0, 0);

    // Filters
    if (booking_type) {
      params.push(booking_type);
      where += ` AND e.booking_type = $${params.length}`;
    }

    if (service_type) {
      params.push(service_type);
      where += ` AND e.service_type = $${params.length}`;
    }

    if (assignment_status) {
      params.push(assignment_status);
      where += ` AND e.assignment_status = $${params.length}`;
    }

    if (task_status) {
      params.push(task_status);
      where += ` AND e.task_status = $${params.length}`;
    }

    if (active !== undefined) {
      params.push(active === "true");
      where += ` AND e.active = $${params.length}`;
    }

    if (resolvedFrom) {
      params.push(resolvedFrom);
      where += ` AND e.start_date >= $${params.length}`;
    }

    if (resolvedTo) {
      params.push(resolvedTo);
      where += ` AND e.end_date <= $${params.length}`;
    }

    if (engagement_status) {
      params.push(String(engagement_status).toUpperCase());
      where += ` AND UPPER(COALESCE(e.engagement_status, '')) = $${params.length}`;
    }

    if (crm_escalated === "true" || crm_escalated === true) {
      where += `
        AND UPPER(COALESCE(e.engagement_status, '')) = 'CRM_ESCALATED'
        AND e.serviceproviderid IS NULL
      `;
    }

    // Main query — one row per engagement (latest payment only, avoids duplicate joins)
    const query = `
      SELECT
        e.engagement_id,
        e.booking_type,
        e.service_type,
        e.assignment_status,
        e.engagement_status,
        e.task_status,
        e.start_date,
        e.end_date,
        e.start_epoch,
        e.end_epoch,
        e.base_amount,
        e.address,
        e.latitude,
        e.longitude,
        e.active,
        e.created_at,

        -- Customer
        c.customerid,
        c.firstname AS customer_firstname,
        c.lastname AS customer_lastname,
        c.mobileno AS customer_mobile,

        -- Provider
        sp.serviceproviderid,
        sp.firstname AS provider_firstname,
        sp.lastname AS provider_lastname,

        p.status AS payment_status,
        p.total_amount,
        p.payment_mode

      FROM engagements e
      JOIN customer c ON c.customerid = e.customerid
      LEFT JOIN serviceprovider sp ON sp.serviceproviderid = e.serviceproviderid
      LEFT JOIN LATERAL (
        SELECT
          p2.status,
          p2.total_amount,
          p2.payment_mode
        FROM payments p2
        WHERE p2.engagement_id = e.engagement_id
        ORDER BY p2.created_at DESC NULLS LAST
        LIMIT 1
      ) p ON true

      ${where}
      ORDER BY e.created_at DESC
      LIMIT ${lim}
      OFFSET ${off}
    `;

    const { rows } = await pool.query(query, params);

    const queueMap = await fetchQueuesForEngagements(
      pool,
      rows.map((r) => r.engagement_id)
    );

    // Count (for pagination)
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM engagements e ${where}`,
      params
    );

    return res.json({
      success: true,
      count: Number(countRes.rows[0].count),
      limit: lim,
      offset: off,
      engagements: rows.map((r) => ({
        engagement_id: r.engagement_id,
        booking_type: r.booking_type,
        service_type: r.service_type,
        assignment_status: r.assignment_status,
        engagement_status: r.engagement_status,
        task_status: r.task_status,
        active: r.active,
        start_date: r.start_date
          ? new Date(r.start_date).toISOString().slice(0, 10)
          : null,
        end_date: r.end_date ? new Date(r.end_date).toISOString().slice(0, 10) : null,
        start_time: r.start_epoch
          ? new Date(r.start_epoch * 1000).toISOString().slice(11, 16)
          : null,
        end_time: r.end_epoch
          ? new Date(r.end_epoch * 1000).toISOString().slice(11, 16)
          : null,
        base_amount: Number(r.base_amount),
        address: r.address || null,
        latitude: r.latitude != null ? Number(r.latitude) : null,
        longitude: r.longitude != null ? Number(r.longitude) : null,

        customer: {
          customerid: r.customerid,
          firstname: r.customer_firstname,
          lastname: r.customer_lastname,
          mobile: r.customer_mobile,
        },

        provider: r.serviceproviderid
          ? {
              serviceproviderid: r.serviceproviderid,
              firstname: r.provider_firstname,
              lastname: r.provider_lastname,
            }
          : null,

        payment: r.payment_status
          ? {
              status: r.payment_status,
              total_amount: Number(r.total_amount),
              payment_mode: r.payment_mode,
            }
          : null,

        provider_queue: queueMap.get(Number(r.engagement_id)) || [],

        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Admin engagements error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});











router.put("/engagements/:id/provider-queue", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { providerIds } = req.body;
    if (!Array.isArray(providerIds) || !providerIds.length) {
      return res.status(400).json({ success: false, error: "providerIds array is required" });
    }

    await client.query("BEGIN");
    const result = await adminSetProviderQueue(client, id, providerIds, {
      adminUserId: req.adminUser?.id || null,
    });
    await client.query("COMMIT");

    return res.json({
      success: true,
      engagement_id: Number(id),
      provider_queue: (result.provider_queue || []).map((row) => ({
        queue_position: Number(row.queue_position),
        role: Number(row.queue_position) === 1 ? "primary" : "backup",
        serviceproviderid: Number(row.serviceproviderid),
        firstname: row.firstname,
        lastname: row.lastname,
        accepted_at: row.accepted_at,
      })),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.get("/vacation-providers", async (req, res) => {
  try {
    const { as_of, include_pending_on_demand, scope, overlap_date } = req.query;
    const vacations = await listActiveVacationPriorityEngagements(pool, {
      asOfDate: as_of || undefined,
      scope: scope === "future" ? "future" : "active",
      overlapDate: overlap_date || undefined,
    });

    const withPending =
      include_pending_on_demand === "true" || include_pending_on_demand === true
        ? await Promise.all(
            vacations.map(async (v) => ({
              ...v,
              pending_on_demand: await listPendingOnDemandForVacationWindow(pool, {
                vacationStart: v.vacation_start_date,
                vacationEnd: v.vacation_end_date,
                serviceType: v.service_type,
              }),
            }))
          )
        : vacations;

    return res.json({
      success: true,
      count: withPending.length,
      vacations: withPending,
    });
  } catch (err) {
    console.error("Admin vacation-providers error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * GET /api/admin/dashboard
 * Aggregated metrics, trends, charts, and recent activity for the admin dashboard.
 */
/**
 * GET /api/admin/alert-reads?admin_user_id=
 * Returns alert keys this admin user has marked read.
 */
router.get("/alert-reads", async (req, res) => {
  try {
    const adminUserId = String(req.query.admin_user_id || "").trim();
    if (!adminUserId) {
      return res.status(400).json({ success: false, error: "admin_user_id is required" });
    }
    const { rows } = await pool.query(
      `SELECT alert_key, read_at
       FROM admin_alert_reads
       WHERE admin_user_id = $1
       ORDER BY read_at DESC
       LIMIT 500`,
      [adminUserId]
    );
    return res.json({
      success: true,
      admin_user_id: adminUserId,
      readKeys: rows.map((r) => r.alert_key),
    });
  } catch (err) {
    console.error("Admin alert-reads list error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * POST /api/admin/alert-reads
 * Body: { admin_user_id, alertKeys: string[] }
 */
router.post("/alert-reads", async (req, res) => {
  try {
    const adminUserId = String(req.body?.admin_user_id || "").trim();
    const alertKeys = Array.isArray(req.body?.alertKeys)
      ? req.body.alertKeys.map((k) => String(k).trim()).filter(Boolean)
      : [];
    if (!adminUserId) {
      return res.status(400).json({ success: false, error: "admin_user_id is required" });
    }
    if (alertKeys.length === 0) {
      return res.status(400).json({ success: false, error: "alertKeys is required" });
    }
    const unique = [...new Set(alertKeys)].slice(0, 200);
    await pool.query(
      `
      INSERT INTO admin_alert_reads (admin_user_id, alert_key, read_at)
      SELECT $1, k, NOW()
      FROM UNNEST($2::text[]) AS k
      ON CONFLICT (admin_user_id, alert_key)
      DO UPDATE SET read_at = EXCLUDED.read_at
      `,
      [adminUserId, unique]
    );
    return res.json({ success: true, saved: unique.length });
  } catch (err) {
    console.error("Admin alert-reads save error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/dashboard", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number.parseInt(String(req.query.days), 10) || 14, 7), 90);

    const [
      countsRes,
      bookingsChartRes,
      revenueChartRes,
      recentCustomersRes,
      recentEngagementsRes,
      paymentSummaryRes,
    ] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::bigint FROM customer) AS customers_total,
          (SELECT COUNT(*)::bigint FROM customer WHERE isactive = true) AS customers_active,
          (SELECT COUNT(*)::bigint FROM customer WHERE enrolleddate >= NOW() - INTERVAL '30 days') AS customers_last_30,
          (SELECT COUNT(*)::bigint FROM customer
            WHERE enrolleddate >= NOW() - INTERVAL '60 days'
              AND enrolleddate < NOW() - INTERVAL '30 days') AS customers_prev_30,

          (SELECT COUNT(*)::bigint FROM serviceprovider) AS providers_total,
          (SELECT COUNT(*)::bigint FROM serviceprovider WHERE isactive = true) AS providers_active,
          (SELECT COUNT(*)::bigint FROM serviceprovider WHERE enrolleddate >= NOW() - INTERVAL '30 days') AS providers_last_30,
          (SELECT COUNT(*)::bigint FROM serviceprovider
            WHERE enrolleddate >= NOW() - INTERVAL '60 days'
              AND enrolleddate < NOW() - INTERVAL '30 days') AS providers_prev_30,

          (SELECT COUNT(*)::bigint FROM engagements) AS engagements_total,
          (SELECT COUNT(*)::bigint FROM engagements WHERE active = true) AS engagements_active,
          (SELECT COUNT(*)::bigint FROM engagements
            WHERE active = true
              AND UPPER(COALESCE(assignment_status, 'UNASSIGNED')) = 'UNASSIGNED') AS engagements_unassigned,
          (SELECT COUNT(*)::bigint FROM engagements WHERE created_at >= NOW() - INTERVAL '30 days') AS engagements_last_30,
          (SELECT COUNT(*)::bigint FROM engagements
            WHERE created_at >= NOW() - INTERVAL '60 days'
              AND created_at < NOW() - INTERVAL '30 days') AS engagements_prev_30
      `),
      pool.query(
        `
        SELECT
          to_char(d::date, 'YYYY-MM-DD') AS date,
          COALESCE(COUNT(e.engagement_id), 0)::int AS count
        FROM generate_series(
          (CURRENT_DATE - ($1::int - 1)),
          CURRENT_DATE,
          '1 day'::interval
        ) AS d
        LEFT JOIN engagements e ON e.created_at::date = d::date
        GROUP BY d::date
        ORDER BY d::date
      `,
        [days]
      ),
      pool.query(
        `
        SELECT
          to_char(d::date, 'YYYY-MM-DD') AS date,
          COALESCE(
            SUM(p.total_amount) FILTER (WHERE UPPER(COALESCE(p.status, '')) = 'SUCCESS'),
            0
          )::numeric AS amount
        FROM generate_series(
          (CURRENT_DATE - ($1::int - 1)),
          CURRENT_DATE,
          '1 day'::interval
        ) AS d
        LEFT JOIN payments p ON p.created_at::date = d::date
        GROUP BY d::date
        ORDER BY d::date
      `,
        [days]
      ),
      pool.query(`
        SELECT customerid, firstname, lastname, enrolleddate
        FROM customer
        ORDER BY enrolleddate DESC NULLS LAST, customerid DESC
        LIMIT 6
      `),
      pool.query(`
        SELECT
          e.engagement_id,
          e.booking_type,
          e.service_type,
          e.assignment_status,
          e.task_status,
          e.created_at,
          c.firstname AS customer_firstname,
          c.lastname AS customer_lastname
        FROM engagements e
        LEFT JOIN customer c ON c.customerid = e.customerid
        ORDER BY e.created_at DESC NULLS LAST, e.engagement_id DESC
        LIMIT 6
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS')::bigint AS success_count,
          COALESCE(SUM(total_amount) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'), 0) AS total_collected,
          COALESCE(SUM((platform_fee - gst)) FILTER (WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'), 0) AS net_revenue,
          COALESCE(
            SUM(total_amount) FILTER (
              WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'
                AND created_at >= NOW() - INTERVAL '30 days'
            ),
            0
          ) AS revenue_last_30,
          COALESCE(
            SUM(total_amount) FILTER (
              WHERE UPPER(COALESCE(status, '')) = 'SUCCESS'
                AND created_at >= NOW() - INTERVAL '60 days'
                AND created_at < NOW() - INTERVAL '30 days'
            ),
            0
          ) AS revenue_prev_30
        FROM payments
      `),
    ]);

    const c = countsRes.rows[0] || {};
    const pay = paymentSummaryRes.rows[0] || {};

    const pctChange = (current, previous) => {
      const cur = Number(current) || 0;
      const prev = Number(previous) || 0;
      if (prev === 0) return cur > 0 ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 100);
    };

    return res.json({
      success: true,
      generated_at: new Date().toISOString(),
      period_days: days,
      counts: {
        customers: {
          total: Number(c.customers_total) || 0,
          active: Number(c.customers_active) || 0,
          last_30_days: Number(c.customers_last_30) || 0,
        },
        providers: {
          total: Number(c.providers_total) || 0,
          active: Number(c.providers_active) || 0,
          last_30_days: Number(c.providers_last_30) || 0,
        },
        engagements: {
          total: Number(c.engagements_total) || 0,
          active: Number(c.engagements_active) || 0,
          unassigned: Number(c.engagements_unassigned) || 0,
          last_30_days: Number(c.engagements_last_30) || 0,
        },
        payments: {
          success_count: Number(pay.success_count) || 0,
          total_collected: Number(pay.total_collected) || 0,
          net_revenue: Number(pay.net_revenue) || 0,
        },
      },
      changes: {
        customers_pct: pctChange(c.customers_last_30, c.customers_prev_30),
        providers_pct: pctChange(c.providers_last_30, c.providers_prev_30),
        engagements_pct: pctChange(c.engagements_last_30, c.engagements_prev_30),
        revenue_pct: pctChange(pay.revenue_last_30, pay.revenue_prev_30),
      },
      charts: {
        bookings_by_day: bookingsChartRes.rows.map((r) => ({
          date: r.date,
          count: Number(r.count) || 0,
        })),
        revenue_by_day: revenueChartRes.rows.map((r) => ({
          date: r.date,
          amount: Number(r.amount) || 0,
        })),
      },
      recent: {
        customers: recentCustomersRes.rows.map((r) => ({
          customerid: Number(r.customerid),
          firstname: r.firstname,
          lastname: r.lastname,
          enrolleddate: r.enrolleddate ? new Date(r.enrolleddate).toISOString() : null,
        })),
        engagements: recentEngagementsRes.rows.map((r) => ({
          engagement_id: Number(r.engagement_id),
          booking_type: r.booking_type,
          service_type: r.service_type,
          assignment_status: r.assignment_status,
          task_status: r.task_status,
          created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
          customer_name: [r.customer_firstname, r.customer_lastname].filter(Boolean).join(" ").trim() || null,
        })),
      },
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;