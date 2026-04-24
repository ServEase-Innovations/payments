import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

/** YYYY-MM-DD calendar day in Asia/Kolkata (same convention as vacationApply / API date strings). */
function engagementCalendarYmd(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

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

    let currentDate = dayjs
      .tz(engagementCalendarYmd(engagement.start_date), "YYYY-MM-DD", "Asia/Kolkata")
      .startOf("day");
    const endDate = dayjs
      .tz(engagementCalendarYmd(engagement.end_date), "YYYY-MM-DD", "Asia/Kolkata")
      .startOf("day");

    while (!currentDate.isAfter(endDate, "day")) {
      const dayStr = currentDate.format("YYYY-MM-DD");

      const dayStart = dayjs
        .tz(dayStr, "YYYY-MM-DD", "Asia/Kolkata")
        .hour(baseStart.hour())
        .minute(baseStart.minute())
        .second(0)
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
          dayStr,
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
