import pool from "./db.js";
async function initDB() {
try {

// Engagements
await pool.query(`
CREATE TABLE IF NOT EXISTS engagements (
engagement_id BIGSERIAL PRIMARY KEY,
customer_id BIGINT REFERENCES customers(customer_id),
provider_id BIGINT REFERENCES service_providers(provider_id),
responsibilities JSONB DEFAULT '[]',
booking_type VARCHAR(50), -- ON_DEMAND, MONTHLY, SHORT_TERM
service_type VARCHAR(50), -- MAID, COOK, NANNY
base_amount DECIMAL(10,2) DEFAULT 0,
start_date DATE,
end_date DATE,
task_status VARCHAR(50) DEFAULT 'NOT_STARTED',
active BOOLEAN DEFAULT TRUE,
created_at TIMESTAMP DEFAULT NOW()
);
`);
// Payments
await pool.query(`
CREATE TABLE IF NOT EXISTS payments (
payment_id BIGSERIAL PRIMARY KEY,
engagement_id BIGINT REFERENCES engagements(engagement_id),
base_amount DECIMAL(10,2) NOT NULL,
platform_fee DECIMAL(10,2) NOT NULL,
gst DECIMAL(10,2) NOT NULL,
total_amount DECIMAL(10,2) NOT NULL,
payment_mode VARCHAR(50), -- razorpay, wallet, cash
transaction_id VARCHAR(255),
status VARCHAR(50) DEFAULT 'PENDING',
created_at TIMESTAMP DEFAULT NOW()
);
`);
// Customer Wallet
await pool.query(`
CREATE TABLE IF NOT EXISTS wallets (
wallet_id BIGSERIAL PRIMARY KEY,
customer_id BIGINT UNIQUE REFERENCES customers(customer_id),
balance DECIMAL(10,2) DEFAULT 0
);
`);
// Wallet Transactions
await pool.query(`
CREATE TABLE wallet_transactions (
transaction_id BIGSERIAL PRIMARY KEY,
customer_id BIGINT REFERENCES customers(customer_id),   -- who owns the wallet
engagement_id BIGINT REFERENCES engagements(engagement_id), -- optional link to engagement
transaction_type VARCHAR(50) NOT NULL,  -- CREDIT | DEBIT | REFUND | ADJUSTMENT
amount NUMERIC(12,2) NOT NULL,          -- actual transaction amount
description TEXT,                       -- e.g. "Vacation refund", "Wallet top-up"
balance_after NUMERIC(12,2),            -- running balance after transaction
created_at TIMESTAMP DEFAULT NOW()
);
`);
// Provider Wallet
await pool.query(`
CREATE TABLE IF NOT EXISTS provider_wallets (
wallet_id BIGSERIAL PRIMARY KEY,
provider_id BIGINT UNIQUE REFERENCES service_providers(provider_id),
balance DECIMAL(10,2) DEFAULT 0,
security_deposit_collected DECIMAL(10,2) DEFAULT 0
);
`);
// Payouts
await pool.query(`
CREATE TABLE IF NOT EXISTS payouts (
payout_id BIGSERIAL PRIMARY KEY,
provider_id BIGINT REFERENCES service_providers(provider_id),
engagement_id BIGINT REFERENCES engagements(engagement_id),
gross_amount DECIMAL(10,2),
provider_fee DECIMAL(10,2),
tds_amount DECIMAL(10,2),
net_amount DECIMAL(10,2),
payout_mode VARCHAR(50), -- bank_transfer, upi, razorpayx
transaction_id VARCHAR(255),
status VARCHAR(50) DEFAULT 'INITIATED',
created_at TIMESTAMP DEFAULT NOW()
);
`);
// Provider Leaves
await pool.query(`
CREATE TABLE IF NOT EXISTS provider_leaves (
leave_id BIGSERIAL PRIMARY KEY,
provider_id BIGINT REFERENCES service_providers(provider_id),
engagement_id BIGINT REFERENCES engagements(engagement_id),
start_date DATE,
end_date DATE,
reason TEXT,
status VARCHAR(50) DEFAULT 'PENDING',
created_at TIMESTAMP DEFAULT NOW()
);
`);
// Customer Leaves
await pool.query(`
CREATE TABLE customer_leaves (
leave_id BIGSERIAL PRIMARY KEY,
customer_id BIGINT REFERENCES customers(customer_id),
engagement_id BIGINT REFERENCES engagements(engagement_id),
leave_type VARCHAR(50),          -- VACATION, SICK, etc.
status VARCHAR(50) DEFAULT 'PENDING',
reason TEXT,                     -- optional reason
leave_start_date DATE,
leave_end_date DATE,
start_date DATE,                 -- for compatibility with API
end_date DATE,
total_days INTEGER,              -- computed duration
refund_amount NUMERIC(12,2),     -- amount refunded to wallet
created_at TIMESTAMP DEFAULT NOW()
);
`);
// Engagement Modifications
await pool.query(`
CREATE TABLE IF NOT EXISTS engagement_modifications (
modification_id BIGSERIAL PRIMARY KEY,
engagement_id BIGINT REFERENCES engagements(engagement_id),
modification_type VARCHAR(50), -- EXTEND, SHORTEN, RESCHEDULE, CANCEL
old_start_date DATE,
old_end_date DATE,
new_start_date DATE,
new_end_date DATE,
created_at TIMESTAMP DEFAULT NOW()
);
`);
console.log("✅ All tables ensured!");
} catch (err) {
console.error("❌ Error initializing DB:", err);
}
}
export default initDB;