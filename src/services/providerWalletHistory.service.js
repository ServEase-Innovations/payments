import pool from "../config/db.js";

function mapLedgerRow(l) {
  return {
    ledger_id: String(l.ledger_id),
    engagement_id: l.engagement_id != null ? String(l.engagement_id) : null,
    amount: Number(l.amount),
    direction: l.direction,
    reason: l.reason,
    reference_type: l.reference_type,
    reference_id: l.reference_id != null ? String(l.reference_id) : null,
    created_at: l.created_at,
  };
}

function mapWithdrawalRow(p) {
  return {
    payout_id: String(p.payout_id),
    engagement_id: p.engagement_id != null ? String(p.engagement_id) : null,
    requested_amount: Number(p.gross_amount),
    gross_amount: Number(p.gross_amount),
    provider_fee: Number(p.provider_fee || 0),
    tds_amount: Number(p.tds_amount || 0),
    net_amount: Number(p.net_amount),
    payout_mode: p.payout_mode,
    status: p.status,
    transaction_id: p.transaction_id || null,
    created_at: p.created_at,
    updated_at: p.updated_at || null,
  };
}

/**
 * Wallet summary, ledger (newest first), and withdrawal/payout rows for an SP.
 * @param {string|number} providerId
 * @param {{ month?: string, ledgerOrder?: 'ASC'|'DESC' }} [opts]
 */
export async function getProviderWalletHistory(providerId, opts = {}) {
  const { month, ledgerOrder = "DESC" } = opts;

  const providerRes = await pool.query(
    `
    SELECT serviceproviderid, security_deposit_collected
    FROM serviceprovider
    WHERE serviceproviderid = $1
    `,
    [providerId]
  );

  if (providerRes.rows.length === 0) {
    return { notFound: true };
  }

  const provider = providerRes.rows[0];

  const walletRes = await pool.query(
    `SELECT balance FROM provider_wallets WHERE serviceproviderid = $1`,
    [providerId]
  );

  const walletBalance =
    walletRes.rows.length > 0 ? Number(walletRes.rows[0].balance) : 0;

  let monthFilterLedger = "";
  let monthFilterPayouts = "";
  const ledgerParams = [providerId];
  const payoutParams = [providerId];

  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return { invalidMonth: true };
    }
    monthFilterLedger = `AND TO_CHAR(created_at, 'YYYY-MM') = $2`;
    monthFilterPayouts = `AND TO_CHAR(created_at, 'YYYY-MM') = $2`;
    ledgerParams.push(month);
    payoutParams.push(month);
  }

  const ledgerRes = await pool.query(
    `
    SELECT
      ledger_id,
      engagement_id,
      amount,
      direction,
      reason,
      reference_type,
      reference_id,
      created_at
    FROM provider_ledger
    WHERE serviceproviderid = $1
    ${monthFilterLedger}
    ORDER BY created_at ${ledgerOrder === "ASC" ? "ASC" : "DESC"}
    `,
    ledgerParams
  );

  const payoutsRes = await pool.query(
    `
    SELECT
      payout_id,
      engagement_id,
      gross_amount,
      provider_fee,
      tds_amount,
      net_amount,
      payout_mode,
      status,
      transaction_id,
      created_at,
      updated_at
    FROM payouts
    WHERE serviceproviderid = $1
    ${monthFilterPayouts}
    ORDER BY created_at DESC
    `,
    payoutParams
  );

  const ledger = ledgerRes.rows;
  const withdrawals = payoutsRes.rows.map(mapWithdrawalRow);

  const totalEarned = ledger
    .filter((l) => l.direction === "CREDIT")
    .reduce((sum, l) => sum + Number(l.amount || 0), 0);

  const totalWithdrawn = ledger
    .filter((l) => l.direction === "DEBIT" && l.reason === "WITHDRAWAL")
    .reduce((sum, l) => sum + Number(l.amount || 0), 0);

  const securityDepositPaid =
    Number(provider.security_deposit_collected || 0) >= 5000;

  return {
    success: true,
    serviceproviderid: String(providerId),
    month: month || null,
    summary: {
      total_earned: Number(totalEarned.toFixed(2)),
      total_withdrawn: Number(totalWithdrawn.toFixed(2)),
      available_to_withdraw: Number(walletBalance.toFixed(2)),
      wallet_balance: Number(walletBalance.toFixed(2)),
      security_deposit_paid: securityDepositPaid,
      security_deposit_amount: Number(provider.security_deposit_collected || 0),
      withdrawal_request_count: withdrawals.length,
    },
    ledger: ledger.map(mapLedgerRow),
    withdrawals,
    payouts: withdrawals,
  };
}
