import express from "express";
import crypto from "crypto";
import pool from "../config/db.js";
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret } from "../utils/razorpayConfig.js";
import {
  authenticateRead,
  loadActor,
  requireOwnCustomerId,
} from "../middleware/resourceAccess.js";
import {
  creditWalletForTopUp,
  ensureCustomerWalletForUpdate,
  WALLET_TOPUP_MAX_INR,
  WALLET_TOPUP_MIN_INR,
} from "../services/customerWallet.service.js";

const router = express.Router();

function roundInr(value) {
  return Math.round(Number(value) * 100) / 100;
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  const body = `${orderId}|${paymentId}`;
  const expectedSignature = crypto
    .createHmac("sha256", getRazorpayKeySecret())
    .update(body)
    .digest("hex");
  return expectedSignature === signature;
}

/**
 * Get wallet balance & transactions for a customer
 */
router.get(
  "/wallets/:customerId",
  authenticateRead,
  loadActor,
  requireOwnCustomerId("customerId"),
  async (req, res) => {
    const { customerId } = req.params;

    try {
      const walletRes = await pool.query(
        `SELECT * FROM customer_wallets WHERE customerid = $1`,
        [customerId]
      );

      let wallet = walletRes.rows[0];
      if (!wallet) {
        const created = await pool.query(
          `INSERT INTO customer_wallets (customerid, balance)
           VALUES ($1, 0)
           ON CONFLICT (customerid) DO UPDATE SET customerid = EXCLUDED.customerid
           RETURNING *`,
          [customerId]
        );
        wallet = created.rows[0];
      }

      const txnRes = await pool.query(
        `SELECT * FROM wallet_transaction
         WHERE wallet_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [wallet.wallet_id]
      );

      res.json({
        customerid: customerId,
        wallet_id: wallet.wallet_id,
        balance: wallet.balance,
        transactions: txnRes.rows,
      });
    } catch (error) {
      console.error("Error fetching wallet:", error);
      res.status(500).json({ error: "Failed to fetch wallet" });
    }
  }
);

/**
 * Create a Razorpay order for wallet top-up.
 */
router.post(
  "/wallets/:customerId/topup",
  authenticateRead,
  loadActor,
  requireOwnCustomerId("customerId"),
  async (req, res) => {
    const { customerId } = req.params;
    const amountInr = roundInr(req.body?.amount);

    if (
      !Number.isFinite(amountInr) ||
      amountInr < WALLET_TOPUP_MIN_INR ||
      amountInr > WALLET_TOPUP_MAX_INR
    ) {
      return res.status(400).json({
        error: `Amount must be between ₹${WALLET_TOPUP_MIN_INR} and ₹${WALLET_TOPUP_MAX_INR.toLocaleString("en-IN")}`,
        code: "INVALID_TOPUP_AMOUNT",
        min_inr: WALLET_TOPUP_MIN_INR,
        max_inr: WALLET_TOPUP_MAX_INR,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const wallet = await ensureCustomerWalletForUpdate(client, customerId);
      const amountPaise = Math.round(amountInr * 100);

      const razorpayOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: `wallet_topup_${customerId}_${Date.now()}`,
        notes: {
          purpose: "WALLET_TOPUP",
          customerId: String(customerId),
        },
      });

      const topupRes = await client.query(
        `INSERT INTO wallet_topups
           (customerid, wallet_id, amount, status, razorpay_order_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'PENDING', $4, NOW(), NOW())
         RETURNING topup_id`,
        [customerId, wallet.wallet_id, amountInr, razorpayOrder.id]
      );

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        topup_id: topupRes.rows[0].topup_id,
        razorpay_order_id: razorpayOrder.id,
        razorpay_key_id: getRazorpayKeyId(),
        amount: amountPaise,
        amount_inr: amountInr,
        currency: "INR",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Wallet top-up create error:", error);
      res.status(500).json({ error: "Failed to start wallet top-up" });
    } finally {
      client.release();
    }
  }
);

/**
 * Verify Razorpay payment and credit the customer wallet.
 */
router.post(
  "/wallets/:customerId/topup/verify",
  authenticateRead,
  loadActor,
  requireOwnCustomerId("customerId"),
  async (req, res) => {
    const { customerId } = req.params;
    const {
      topup_id: topupIdRaw,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body ?? {};

    const topupId = Number(topupIdRaw);
    if (
      !Number.isFinite(topupId) ||
      topupId < 1 ||
      !razorpay_order_id ||
      !razorpay_payment_id
    ) {
      return res.status(400).json({ error: "Invalid top-up verification payload" });
    }

    if (
      !verifyRazorpaySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      )
    ) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const topupRes = await client.query(
        `SELECT *
         FROM wallet_topups
         WHERE topup_id = $1
           AND customerid = $2
         FOR UPDATE`,
        [topupId, customerId]
      );

      if (!topupRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Top-up not found" });
      }

      const topup = topupRes.rows[0];

      if (topup.razorpay_order_id !== razorpay_order_id) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Order id does not match top-up" });
      }

      if (topup.status === "SUCCESS") {
        const balanceRes = await client.query(
          `SELECT balance FROM customer_wallets WHERE wallet_id = $1`,
          [topup.wallet_id]
        );
        await client.query("COMMIT");
        return res.json({
          success: true,
          alreadyProcessed: true,
          balance: balanceRes.rows[0]?.balance ?? null,
          topup_id: topup.topup_id,
        });
      }

      if (topup.status !== "PENDING") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Top-up is not payable" });
      }

      const creditResult = await creditWalletForTopUp(client, {
        customerId,
        amount: topup.amount,
        description: "Wallet top-up",
        topupId: topup.topup_id,
      });

      await client.query(
        `UPDATE wallet_topups
         SET status = 'SUCCESS',
             razorpay_payment_id = $1,
             updated_at = NOW()
         WHERE topup_id = $2`,
        [razorpay_payment_id, topup.topup_id]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "Wallet topped up successfully",
        balance: creditResult.balance_after,
        topup_id: topup.topup_id,
        amount_inr: roundInr(topup.amount),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Wallet top-up verify error:", error);
      res.status(500).json({ error: "Failed to verify wallet top-up" });
    } finally {
      client.release();
    }
  }
);

export default router;
