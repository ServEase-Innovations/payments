import pool from "../config/db.js";
import { transitionEngagement } from "./engagementLifecycle.js";

export async function handlePaymentSuccess({
  engagementId,
  razorpay_order_id,
  razorpay_payment_id,
  rawEvent = null,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 🔒 Lock payment row (idempotency safe)
    const paymentRes = await client.query(
      `SELECT * FROM payments
       WHERE razorpay_order_id = $1
       FOR UPDATE`,
      [razorpay_order_id]
    );

    if (paymentRes.rows.length === 0) {
      throw new Error("Payment not found");
    }

    const payment = paymentRes.rows[0];

    // 🛑 If already processed → exit safely
    if (payment.status === "SUCCESS") {
      await client.query("COMMIT");
      return { alreadyProcessed: true };
    }

    // 🔒 Lock engagement row
    const engRes = await client.query(
      `SELECT engagement_id, booking_type, engagement_status
       FROM engagements
       WHERE engagement_id = $1
       FOR UPDATE`,
      [engagementId]
    );

    if (engRes.rows.length === 0) {
      throw new Error("Engagement not found");
    }

    const engagement = engRes.rows[0];

    // ✅ Update payment
    await client.query(
      `
      UPDATE payments
      SET status = 'SUCCESS',
          transaction_id = $1,
          updated_at = NOW()
      WHERE razorpay_order_id = $2
      `,
      [razorpay_payment_id, razorpay_order_id]
    );

    // 🎯 Decide next lifecycle state (VALID ENUM ONLY)
    let nextStatus;

    if (engagement.booking_type === "ON_DEMAND") {
      nextStatus = "UNASSIGNED";
    } else {
      nextStatus = "ASSIGNED";
    }

    // 🔁 Lifecycle transition
    await transitionEngagement(client, {
      engagementId,
      newStatus: nextStatus,
      eventType: "PAYMENT_COMPLETED",
      actorType: "SYSTEM",
      actorId: null,
      metadata: {
        razorpay_order_id,
        razorpay_payment_id,
        source: rawEvent ? "WEBHOOK" : "VERIFY",
      },
    });

    await client.query("COMMIT");

    return { success: true };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
