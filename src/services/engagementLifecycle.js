import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export async function transitionEngagement(client, {
  engagementId,
  newStatus,
  eventType,
  actorType = "SYSTEM",
  actorId = null,
  metadata = {}
}) {

  const res = await client.query(
    `SELECT * FROM engagements
     WHERE engagement_id=$1
     FOR UPDATE`,
    [engagementId]
  );

  if (!res.rows.length) {
    throw new Error("Engagement not found");
  }

  const engagement = res.rows[0];
  const currentStatus = engagement.engagement_status;

  if (currentStatus === newStatus) return;

  // 1️⃣ Update status
  await client.query(
    `UPDATE engagements
     SET engagement_status=$1
     WHERE engagement_id=$2`,
    [newStatus, engagementId]
  );

  // 2️⃣ Insert lifecycle event
  await client.query(
    `INSERT INTO engagement_events
     (engagement_id, from_status, to_status,
      event_type, actor_type, actor_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      engagementId,
      currentStatus,
      newStatus,
      eventType,
      actorType,
      actorId,
      JSON.stringify(metadata)
    ]
  );

  // =====================================================
  // 🔥 AVAILABILITY ENGINE
  // =====================================================

  // 🔹 Block availability when ASSIGNED
  if (newStatus === "ASSIGNED" && engagement.serviceproviderid) {

    const baseStart = dayjs
      .unix(engagement.start_epoch)
      .tz("Asia/Kolkata");

    const durationSec = (engagement.duration_minutes || 60) * 60;

    let currentDate = dayjs(engagement.start_date);
    const endDate = dayjs(engagement.end_date);

    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate)) {

      const dayStart = dayjs(currentDate.format("YYYY-MM-DD"))
        .hour(baseStart.hour())
        .minute(baseStart.minute())
        .second(0)
        .tz("Asia/Kolkata")
        .unix();

      const dayEnd = dayStart + durationSec;

      // Prevent duplicate inserts
      await client.query(
        `
        INSERT INTO provider_availability
        (serviceproviderid, engagement_id, date,
         slot_start_epoch, slot_end_epoch,
         status, created_at, updated_at)
        VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())
        ON CONFLICT DO NOTHING
        `,
        [
          engagement.serviceproviderid,
          engagement.engagement_id,
          currentDate.format("YYYY-MM-DD"),
          dayStart,
          dayEnd
        ]
      );

      currentDate = currentDate.add(1, "day");
    }
  }

  // 🔹 Release availability when cancelled
  if (newStatus === "CANCELLED") {
    await client.query(
      `DELETE FROM provider_availability
       WHERE engagement_id=$1`,
      [engagementId]
    );
  }
}
