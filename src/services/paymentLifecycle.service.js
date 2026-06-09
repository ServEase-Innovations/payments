import pool from "../config/db.js";
import geolib from "geolib";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { transitionEngagement } from "./engagementLifecycle.js";
import {
  upsertProviderNewBookingNotification,
  dismissNewBookingInAppByEngagementId,
  InAppTypes,
  createInAppNotification,
} from "./inAppNotification.service.js";
import { getSocketServer } from "../utils/socketIoRef.js";
import { dismissPaymentPendingRemindersForEngagement } from "./paymentPendingReminder.service.js";

dayjs.extend(utc);
dayjs.extend(timezone);

/** Max distance (m) to notify providers of a paid on-demand booking. */
const ON_DEMAND_NOTIFY_RADIUS_M = 12_000;
const ON_DEMAND_NOTIFY_FALLBACK_RADIUS_M = 30_000;

async function notifyOnDemandProvider(socketServer, engagement, providerRow, distanceM) {
  const spid = Number(providerRow.serviceproviderid);
  if (!Number.isFinite(spid) || spid < 1) return false;

  const room = `provider_${spid}`;
  const roomSet = socketServer.sockets.adapter.rooms.get(room);
  const connectedCount = roomSet ? roomSet.size : 0;

  console.log(
    `📡 Broadcasting engagement ${engagement.engagement_id} → ${room}`,
    "| connections:",
    connectedCount
  );
  if (connectedCount === 0) {
    console.warn(
      `No live socket in ${room} — provider must keep the app open while logged in so the UI joins that room.`
    );
  }

  const distanceKm = Math.round((distanceM / 1000) * 10) / 10;
  const startTimeLabel = engagement.start_epoch
    ? dayjs
        .unix(Number(engagement.start_epoch))
        .tz("Asia/Kolkata")
        .format("D MMM YYYY, h:mm a")
    : engagement.start_date
      ? String(engagement.start_date)
      : "";
  const addressLine = engagement.address ? String(engagement.address).trim() : "";

  socketServer.to(room).emit("new-engagement-request", {
    engagement_id: engagement.engagement_id,
    service_type: engagement.service_type,
    booking_type: engagement.booking_type,
    start_date: engagement.start_date,
    start_epoch: engagement.start_epoch,
    duration_minutes: engagement.duration_minutes,
    base_amount: engagement.base_amount,
    address: addressLine || null,
    distance_meters: distanceM,
    payment_ready: true,
  });

  const amountLabel =
    engagement.base_amount != null && engagement.base_amount !== ""
      ? `₹${engagement.base_amount}`
      : null;
  const summaryParts = [
    engagement.service_type,
    startTimeLabel ? `Starts ${startTimeLabel}` : null,
    `~${distanceKm} km from you`,
    amountLabel,
  ].filter(Boolean);
  const bodyText = summaryParts.join(" · ");

  try {
    await upsertProviderNewBookingNotification({
      io: socketServer,
      recipientId: spid,
      engagementId: engagement.engagement_id,
      title: "New paid booking nearby — tap to review",
      body: bodyText,
      metadata: {
        service_type: engagement.service_type,
        booking_type: engagement.booking_type,
        start_date: engagement.start_date,
        start_epoch: engagement.start_epoch,
        start_time_label: startTimeLabel,
        duration_minutes: engagement.duration_minutes,
        base_amount: engagement.base_amount,
        distance_m: distanceM,
        distance_km: distanceKm,
        address: addressLine || null,
        payment_ready: true,
      },
    });
  } catch (e) {
    console.error("in-app notification (payment success) failed", e);
  }
  return true;
}

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

    // 🎯 Decide next engagement state (align with webhook: ON_DEMAND → OPEN_FOR_ACCEPTANCE)
    let nextStatus =
      engagement.booking_type === "ON_DEMAND"
        ? "OPEN_FOR_ACCEPTANCE"
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
  // AFTER COMMIT → realtime + in-app notifications
  // =================================================

  const freshEng = await pool.query(
    `SELECT * FROM engagements WHERE engagement_id = $1`,
    [engagementId]
  );
  if (freshEng.rows.length) {
    engagement = freshEng.rows[0];
  }

  const socketServer = io != null ? io : getSocketServer();
  console.log(`Payment successful for engagement ${engagementId}.`);

  try {
    await dismissPaymentPendingRemindersForEngagement(engagementId);
  } catch (eDismissPending) {
    console.error("dismiss payment-pending reminders failed", eDismissPending);
  }

  if (engagement.booking_type === "ON_DEMAND" && socketServer) {
    const life = String(engagement.engagement_status || "").toUpperCase();
    const alreadyAssigned =
      engagement.serviceproviderid != null &&
      String(engagement.serviceproviderid).trim() !== "";
    if (
      alreadyAssigned ||
      !["OPEN_FOR_ACCEPTANCE", "UNASSIGNED"].includes(life)
    ) {
      console.log(
        `Skip ON_DEMAND provider notify for engagement ${engagementId} (status=${life}, assigned=${alreadyAssigned})`
      );
      return { success: true };
    }

    try {
      await dismissNewBookingInAppByEngagementId(engagement.engagement_id);
    } catch (eDismiss) {
      console.error("dismiss pre-payment new-booking rows failed", eDismiss);
    }
    console.log("==== DISPATCH DEBUG ====");
    console.log("booking_type:", engagement.booking_type);
    console.log("io defined?", !!io);
    console.log("latitude:", engagement.latitude);
    console.log("longitude:", engagement.longitude);
    console.log("========================");

    console.log(
      `Payment successful for ON_DEMAND engagement ${engagementId}. Checking for nearby providers...`
    );

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

    console.log(
      `Broadcasting new ON_DEMAND engagement ${engagement.engagement_id} to nearby providers...`
    );

    const customerPoint = {
      latitude: engagement.latitude,
      longitude: engagement.longitude,
    };
    const distances = providers.rows.map((p) => ({
      row: p,
      distance: geolib.getDistance(customerPoint, {
        latitude: p.latitude,
        longitude: p.longitude,
      }),
    }));

    let notified = 0;
    const notifiedIds = new Set();

    const notifyWithin = async (maxM) => {
      for (const { row, distance } of distances) {
        if (distance > maxM) continue;
        const spid = Number(row.serviceproviderid);
        if (!Number.isFinite(spid) || spid < 1 || notifiedIds.has(spid)) continue;
        /* eslint-disable no-await-in-loop */
        const ok = await notifyOnDemandProvider(socketServer, engagement, row, distance);
        /* eslint-enable no-await-in-loop */
        if (ok) {
          notifiedIds.add(spid);
          notified += 1;
        }
      }
    };

    await notifyWithin(ON_DEMAND_NOTIFY_RADIUS_M);
    if (notified === 0) {
      console.warn(
        `No providers within ${ON_DEMAND_NOTIFY_RADIUS_M}m for engagement ${engagement.engagement_id} — widening to ${ON_DEMAND_NOTIFY_FALLBACK_RADIUS_M}m`
      );
      await notifyWithin(ON_DEMAND_NOTIFY_FALLBACK_RADIUS_M);
    }
    console.log(
      `ON_DEMAND engagement ${engagement.engagement_id}: notified ${notified} provider(s)`
    );
  } else if (
    (engagement.booking_type === "SHORT_TERM" ||
      engagement.booking_type === "MONTHLY") &&
    engagement.serviceproviderid
  ) {
    const spid = Number(engagement.serviceproviderid);
    if (Number.isFinite(spid) && spid > 0) {
      const room = `provider_${spid}`;
      const startTimeLabel = engagement.start_epoch
        ? dayjs
            .unix(Number(engagement.start_epoch))
            .tz("Asia/Kolkata")
            .format("D MMM YYYY, h:mm a")
        : engagement.start_date
          ? String(engagement.start_date)
          : "";
      const endDateLabel = engagement.end_date
        ? String(engagement.end_date)
        : "";
      const addressLine = engagement.address
        ? String(engagement.address).trim()
        : "";
      const amountLabel =
        engagement.base_amount != null && engagement.base_amount !== ""
          ? `₹${engagement.base_amount}`
          : null;
      const summaryParts = [
        engagement.service_type,
        engagement.booking_type,
        startTimeLabel ? `Starts ${startTimeLabel}` : null,
        endDateLabel ? `Ends ${endDateLabel}` : null,
        amountLabel,
      ].filter(Boolean);
      const bodyText = summaryParts.join(" · ");

      if (socketServer) {
        socketServer.to(room).emit("new-engagement-request", {
          engagement_id: engagement.engagement_id,
          service_type: engagement.service_type,
          booking_type: engagement.booking_type,
          start_date: engagement.start_date,
          end_date: engagement.end_date,
          start_epoch: engagement.start_epoch,
          end_epoch: engagement.end_epoch,
          duration_minutes: engagement.duration_minutes,
          base_amount: engagement.base_amount,
          address: addressLine || null,
          payment_completed: true,
        });
      }

      try {
        await createInAppNotification({
          io: socketServer,
          recipientType: "provider",
          recipientId: spid,
          type: InAppTypes.ASSIGNED_BOOKING_CONFIRMED,
          title: "Booking confirmed",
          body: bodyText,
          engagementId: engagement.engagement_id,
          metadata: {
            service_type: engagement.service_type,
            booking_type: engagement.booking_type,
            start_date: engagement.start_date,
            end_date: engagement.end_date,
            start_epoch: engagement.start_epoch,
            end_epoch: engagement.end_epoch,
            start_time_label: startTimeLabel,
            duration_minutes: engagement.duration_minutes,
            base_amount: engagement.base_amount,
            address: addressLine || null,
          },
        });
      } catch (e) {
        console.error(
          "in-app notification (assigned booking payment success) failed",
          e
        );
      }
    }
  }

  return { success: true };
}