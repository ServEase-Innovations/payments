import express from "express";
import pool from "../config/db.js";

const router = express.Router();

/**
 * Get wallet balance & transactions for a customer
 */
router.get("/wallets/:customerId", async (req, res) => {
  const { customerId } = req.params;

  try {
    // 1️⃣ Fetch wallet
    const walletRes = await pool.query(
      `SELECT * FROM customer_wallets WHERE customerid = $1`,
      [customerId]
    );

    if (walletRes.rows.length === 0) {
      return res.status(404).json({ error: "Wallet not found for this customer" });
    }

    const wallet = walletRes.rows[0];

    // 2️⃣ Fetch recent transactions (latest 10)
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
});


export default router;
