import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";
import pool from "../src/config/db.js";
import { razorpay } from "../src/utils/razorpayConfig.js";

// Ensure auth is completely bypassed to focus on route logic
process.env.JWT_PROTECT_READS = "false";
process.env.JWT_PROTECT_MUTATIONS = "false";

import walletRoutes from "../src/routes/walletRoutes.js";

const app = express();
app.use(express.json());
app.use("/api", walletRoutes);

describe("Wallet Routes Unit Tests", () => {
  let queryMock;

  beforeEach(() => {
    // Reset the query mock before each test
    queryMock = async () => ({ rows: [] });
    pool.query = async (text, params) => queryMock(text, params);
    
    // Mock pool.connect to return a mock client
    pool.connect = async () => ({
      query: async (text, params) => {
        // console.log("client.query", text);
        return queryMock(text, params);
      },
      release: () => {},
    });
  });

  it("GET /api/wallets/:customerId fetches existing wallet", async () => {
    queryMock = async (text, params) => {
      if (text.includes("SELECT * FROM customer_wallets")) {
        return { rows: [{ wallet_id: 99, customerid: params[0], balance: 500 }] };
      }
      if (text.includes("SELECT * FROM wallet_transaction")) {
        return { rows: [{ txn_id: 1, amount: 500 }] };
      }
      return { rows: [] };
    };

    const res = await request(app).get("/api/wallets/1");
    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 500);
    assert.equal(res.body.transactions.length, 1);
  });

  it("GET /api/wallets/:customerId creates wallet if missing", async () => {
    queryMock = async (text, params) => {
      if (text.includes("SELECT * FROM customer_wallets")) {
        return { rows: [] }; // Mock missing wallet
      }
      if (text.includes("INSERT INTO customer_wallets")) {
        return { rows: [{ wallet_id: 100, customerid: params[0], balance: 0 }] };
      }
      if (text.includes("SELECT * FROM wallet_transaction")) {
        return { rows: [] };
      }
      return { rows: [] };
    };

    const res = await request(app).get("/api/wallets/2");
    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 0);
    assert.equal(res.body.wallet_id, 100);
  });

  it("GET /api/wallets/:customerId returns 500 on db error", async () => {
    queryMock = async () => {
      throw new Error("Database failure");
    };

    const res = await request(app).get("/api/wallets/3");
    assert.equal(res.status, 500);
  });

  it("POST /api/wallets/:customerId/topup rejects invalid amount", async () => {
    const res = await request(app).post("/api/wallets/1/topup").send({ amount: 5 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Amount must be between/);
  });

  it("POST /api/wallets/:customerId/topup successfully creates pending order", async () => {
    // Mock Razorpay
    razorpay.orders = {
      create: async () => ({ id: "order_mock123" })
    };

    queryMock = async (text, params) => {
      if (text.includes("INSERT INTO wallet_topups")) {
        return { rows: [{ topup_id: 88 }] };
      }
      return { rows: [{ wallet_id: 111, customerid: params ? params[0] : 1, balance: 100 }] };
    };

    const res = await request(app).post("/api/wallets/1/topup").send({ amount: 500 });
    assert.equal(res.status, 201);
    assert.equal(res.body.topup_id, 88);
    assert.equal(res.body.razorpay_order_id, "order_mock123");
  });

  it("POST /api/wallets/:customerId/topup returns 500 on error", async () => {
    queryMock = async (text) => {
      if (text.includes("BEGIN") || text.includes("ROLLBACK")) return { rows: [] };
      throw new Error("DB Error in transaction");
    };

    const res = await request(app).post("/api/wallets/1/topup").send({ amount: 500 });
    assert.equal(res.status, 500);
  });

  it("POST /api/wallets/:customerId/topup/verify rejects invalid payload", async () => {
    const res = await request(app).post("/api/wallets/1/topup/verify").send({});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid top-up verification payload/);
  });

  it("POST /api/wallets/:customerId/topup/verify rejects empty body", async () => {
    // Calling without .send() tests the req.body ?? {} branch
    const res = await request(app).post("/api/wallets/1/topup/verify");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid top-up verification payload/);
  });

  it("POST /api/wallets/:customerId/topup/verify handles production signature check", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    
    // We expect it to fail the signature check because we didn't sign it
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123",
      razorpay_signature: "bad_signature"
    });
    
    process.env.NODE_ENV = originalEnv;
    
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid payment signature/);
  });

  it("POST /api/wallets/:customerId/topup/verify returns 404 if topup not found", async () => {
    queryMock = async () => ({ rows: [] });
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123"
    });
    assert.equal(res.status, 404);
  });

  it("POST /api/wallets/:customerId/topup/verify handles already processed", async () => {
    queryMock = async (text) => {
      if (text.includes("wallet_topups")) {
        return { rows: [{ topup_id: 99, status: "SUCCESS", razorpay_order_id: "order_123", wallet_id: 111 }] };
      }
      if (text.includes("balance FROM customer_wallets")) {
        return { rows: [{ balance: 1000 }] };
      }
      return { rows: [] };
    };
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123"
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyProcessed, true);
    assert.equal(res.body.balance, 1000);
  });

  it("POST /api/wallets/:customerId/topup/verify handles already processed missing wallet", async () => {
    queryMock = async (text) => {
      if (text.includes("wallet_topups")) {
        return { rows: [{ topup_id: 99, status: "SUCCESS", razorpay_order_id: "order_123", wallet_id: 111 }] };
      }
      if (text.includes("balance FROM customer_wallets")) {
        return { rows: [] }; // Tests the ?.balance ?? null branch
      }
      return { rows: [] };
    };
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123"
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyProcessed, true);
    assert.equal(res.body.balance, null);
  });

  it("POST /api/wallets/:customerId/topup/verify rejects order id mismatch", async () => {
    queryMock = async (text) => {
      if (text.includes("wallet_topups")) {
        return { rows: [{ topup_id: 99, status: "PENDING", razorpay_order_id: "order_DIFFERENT" }] };
      }
      return { rows: [] };
    };
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123"
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Order id does not match top-up/);
  });

  it("POST /api/wallets/:customerId/topup/verify rejects non-pending", async () => {
    queryMock = async (text) => {
      if (text.includes("wallet_topups")) {
        return { rows: [{ topup_id: 99, status: "CANCELLED", razorpay_order_id: "order_123" }] };
      }
      return { rows: [] };
    };
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123"
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Top-up is not payable/);
  });

  it("POST /api/wallets/:customerId/topup/verify succeeds for valid payment", async () => {
    queryMock = async (text, params) => {
      if (text.includes("wallet_topups")) {
        return { rows: [{ topup_id: 99, status: "PENDING", razorpay_order_id: "order_123", amount: 500, wallet_id: 111 }] };
      }
      if (text.includes("customer_wallets")) {
        return { rows: [{ wallet_id: 111, balance: 100, customerid: 1 }] };
      }
      if (text.includes("wallet_transaction")) {
        return { rows: [{ balance_after: 600 }] };
      }
      return { rows: [] };
    };
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123"
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.balance, 600);
  });

  it("POST /api/wallets/:customerId/topup/verify returns 500 on db error", async () => {
    queryMock = async (text) => {
      if (text.includes("BEGIN") || text.includes("ROLLBACK")) return { rows: [] };
      throw new Error("DB Error verify");
    };
    const res = await request(app).post("/api/wallets/1/topup/verify").send({
      topup_id: 99,
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123"
    });
    assert.equal(res.status, 500);
  });
});
