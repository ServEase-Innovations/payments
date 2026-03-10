import pool from "../config/db.js";
import geolib from "geolib";
import { transitionEngagement } from "./engagementLifecycle.js";

export async function handlePaymentSuccess({
  engagementId,
  razorpay_order_id,
  razorpay_payment_id,
  rawEvent = null,
  io
}) {
  const client = await pool.connect();

  let engagement;

  try {
    await client.query("BEGIN");

    // 🔒 Lock payment row
    const paymentRes = await client.query(
      `SELECT * FROM payments
       WHERE razorpay_order_id = $1
       FOR UPDATE`,
      [razorpay_order_id]
    );

    if (!paymentRes.rows.length) {
      throw new Error("Payment not found");
    }

    const payment = paymentRes.rows[0];

    // 🛑 Idempotent check
    if (payment.status === "SUCCESS") {
      await client.query("COMMIT");
      return { alreadyProcessed: true };
    }

    // 🔒 Lock engagement row
    const engRes = await client.query(
      `SELECT * FROM engagements
       WHERE engagement_id = $1
       FOR UPDATE`,
      [engagementId]
    );

    if (!engRes.rows.length) {
      throw new Error("Engagement not found");
    }

    engagement = engRes.rows[0];

    // ✅ Update payment
    await client.query(
      `
      UPDATE payments
      SET status='SUCCESS',
          transaction_id=$1,
          updated_at=NOW()
      WHERE razorpay_order_id=$2
      `,
      [razorpay_payment_id, razorpay_order_id]
    );

    // 🎯 Decide next engagement state
    let nextStatus =
      engagement.booking_type === "ON_DEMAND"
        ? "UNASSIGNED"
        : "ASSIGNED";

    // 🔁 Lifecycle transition
    await transitionEngagement(client, {
      engagementId,
      newStatus: nextStatus,
      eventType: "PAYMENT_COMPLETED",
      actorType: "SYSTEM",
      metadata: {
        source: rawEvent ? "WEBHOOK" : "VERIFY",
        razorpay_order_id,
        razorpay_payment_id
      }
    });

    await client.query("COMMIT");

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // =================================================
  // AFTER COMMIT → Dispatch for ON_DEMAND
  // =================================================

  console.log(`Payment successful for engagement ${engagementId}.` , io);
  if (engagement.booking_type === "ON_DEMAND" && io) {


    console.log("==== DISPATCH DEBUG ====");
console.log("booking_type:", engagement.booking_type);
console.log("io defined?", !!io);
console.log("latitude:", engagement.latitude);
console.log("longitude:", engagement.longitude);
console.log("========================");

    console.log(`Payment successful for ON_DEMAND engagement ${engagementId}. Checking for nearby providers...`);

    if (!engagement.latitude || !engagement.longitude) {
      return { success: true };
    }

    const providers = await pool.query(`
      SELECT serviceproviderid, latitude, longitude
      FROM serviceprovider
      WHERE isactive = true
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
    `);


    console.log(`Broadcasting new ON_DEMAND engagement ${engagement.engagement_id} to nearby providers...`);

    for (const p of providers.rows) {
      const distance = geolib.getDistance(
        { latitude: engagement.latitude, longitude: engagement.longitude },
        { latitude: p.latitude, longitude: p.longitude }
      );

      socket.on("join", ({ providerId }) => {
  socket.join(`provider_${providerId}`);
  console.log(`Provider joined: provider_${providerId}`);
});

      if (distance <= 5000) {
        console.log("Broadcasting ON_DEMAND:", engagement.engagement_id);
        io.to(room).emit(
          "new-engagement",
          {
            engagement_id: engagement.engagement_id,
            service_type: engagement.service_type,
            start_date: engagement.start_date,
            start_epoch: engagement.start_epoch,
            duration_minutes: engagement.duration_minutes,
            base_amount: engagement.base_amount,
          }
        );
      }
    }
  }

  return { success: true };
}