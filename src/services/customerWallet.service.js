function roundInr(value) {
  return Math.round(Number(value) * 100) / 100;
}

export async function getCustomerWalletBalance(client, customerId) {
  const res = await client.query(
    `SELECT balance FROM customer_wallets WHERE customerid = $1`,
    [customerId]
  );
  if (!res.rows.length) return 0;
  return roundInr(res.rows[0].balance);
}

/**
 * How much wallet can apply toward `totalAmount` when the customer opts in.
 */
export function computeWalletApplication(walletBalance, totalAmount, useWallet) {
  const total = roundInr(totalAmount);
  if (!useWallet || total <= 0) {
    return { wallet_amount: 0, razorpay_amount: total };
  }
  const balance = Math.max(0, roundInr(walletBalance));
  const wallet_amount = roundInr(Math.min(balance, total));
  const razorpay_amount = roundInr(total - wallet_amount);
  return { wallet_amount, razorpay_amount };
}

/**
 * Debit customer wallet inside an open transaction. Throws if balance is insufficient.
 */
export async function deductWalletForPayment(
  client,
  { customerId, engagementId, amount, description }
) {
  const debit = roundInr(amount);
  if (!Number.isFinite(debit) || debit <= 0) return 0;

  const walletRes = await client.query(
    `SELECT wallet_id, balance
     FROM customer_wallets
     WHERE customerid = $1
     FOR UPDATE`,
    [customerId]
  );

  if (!walletRes.rows.length) {
    const err = new Error("Insufficient wallet balance");
    err.statusCode = 400;
    throw err;
  }

  const walletId = walletRes.rows[0].wallet_id;
  const balance = roundInr(walletRes.rows[0].balance);
  if (balance < debit) {
    const err = new Error("Insufficient wallet balance");
    err.statusCode = 400;
    throw err;
  }

  await client.query(
    `UPDATE customer_wallets
     SET balance = balance - $1,
         updated_at = NOW()
     WHERE wallet_id = $2`,
    [debit, walletId]
  );

  const balanceAfter = roundInr(balance - debit);
  const label =
    description ||
    (engagementId != null
      ? `Payment for booking #${engagementId}`
      : "Booking payment");

  await client.query(
    `INSERT INTO wallet_transaction
       (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
     VALUES ($1, $2, $3, $4, 'DEBIT', $5, $6)`,
    [walletId, customerId, engagementId, debit, label, balanceAfter]
  );

  return debit;
}
