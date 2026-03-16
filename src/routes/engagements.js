// routes/engagements.js  (Version A — Epoch Only, combined: PUT, vacation, cancellation, payouts)
import express from "express";
import pool from "../config/db.js";
import Razorpay from "razorpay";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import geolib from "geolib";
import { io } from "../../index.js";
import { createServiceDays } from "../routes/serviceDays.service.js";


dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_lTdgjtSRlEwreA",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "g15WB8CEwaYBQ5FqpIKKMdNS",
});

// ----------------- Helpers -----------------

function toEpochSeconds(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dt = dayjs.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
  if (!dt.isValid()) return null;
  return dt.unix();
}

function epochToTimeHM(epochSeconds) {
  if (!epochSeconds) return null;
  return dayjs.unix(Number(epochSeconds)).tz("Asia/Kolkata").format("HH:mm");
}

function normalizeDateToIST(dateValue) {
  if (!dateValue) return null;
  const d = new Date(dateValue);
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

function enumerateDates(start, end) {
  const res = [];
  const cur = new Date(start);
  while (cur <= end) {
    res.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return res;
}

async function getCustomerWalletId(client, customerId) {
  const walletRes = await client.query(`SELECT wallet_id FROM customer_wallets WHERE customerid=$1`, [customerId]);
  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(`INSERT INTO customer_wallets (customerid, balance) VALUES ($1,0) RETURNING wallet_id`, [customerId]);
    return insertRes.rows[0].wallet_id;
  }
  return walletRes.rows[0].wallet_id;
}

async function ensureProviderWallet(client, providerId) {
  if (!providerId) return null;
  const walletRes = await client.query(`SELECT * FROM provider_wallets WHERE serviceproviderid=$1`, [providerId]);
  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(`INSERT INTO provider_wallets (serviceproviderid, balance, security_deposit_collected) VALUES ($1,0,0) RETURNING *`, [providerId]);
    return insertRes.rows[0];
  }
  return walletRes.rows[0];
}

// small util: compute daily rate
function computeDailyRate(baseAmount, startDate, endDate) {
  const totalDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) + 1;
  return Number(baseAmount) / totalDays;
}





// ----------------- CREATE Engagement -----------------

router.post("/", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customerid,
      serviceproviderid, // optional (MONTHLY), always null for ON_DEMAND
      start_date,
      end_date,
      start_time,
      responsibilities,
      booking_type, // ON_DEMAND | MONTHLY
      service_type,
      base_amount,
      latitude,
      longitude,
      payment_mode = "razorpay",
    } = req.body;

    // 1️⃣ Validation
    if (!customerid || !start_date || !end_date || !start_time || !base_amount || !booking_type || !service_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const providerId = booking_type === "ON_DEMAND" ? null : serviceproviderid;
    const assignment_status = booking_type === "ON_DEMAND" ? "UNASSIGNED" : "ASSIGNED";

    // 2️⃣ Epochs — ONLY for non-ON_DEMAND
    const startEpoch = toEpochSeconds(start_date, start_time);
if (!startEpoch) throw new Error("Invalid date/time");

const hoursToAdd = booking_type === "ON_DEMAND" ? 2 : 1;
const endEpoch = startEpoch + hoursToAdd * 3600;

const effectiveEndDate =
  booking_type === "ON_DEMAND" ? start_date : end_date;


    await client.query("BEGIN");

    // 3️⃣ FK validation
    const cust = await client.query(
      `SELECT customerid, firstName, lastName FROM customer WHERE customerid=$1`,
      [customerid]
    );
    if (cust.rows.length === 0) throw new Error("Customer not found");

    if (providerId) {
      const prov = await client.query(
        `SELECT serviceproviderid FROM serviceprovider WHERE serviceproviderid=$1`,
        [providerId]
      );
      if (prov.rows.length === 0) throw new Error("Provider not found");
    }

    // 4️⃣ Overlap check (ONLY for non-ON_DEMAND)
    if (providerId && booking_type !== "ON_DEMAND") {
      const overlap = await client.query(
        `SELECT 1 FROM provider_availability
         WHERE serviceproviderid=$1
           AND $2 < slot_end_epoch
           AND $3 > slot_start_epoch
         LIMIT 1`,
        [providerId, startEpoch, endEpoch]
      );
      if (overlap.rows.length) {
        throw new Error("Provider already has a booking at this time");
      }
    }

    // 5️⃣ Create engagement
    const engRes = await client.query(
  `
  INSERT INTO engagements (
    customerid,
    serviceproviderid,
    start_date,
    end_date,
    responsibilities,
    booking_type,
    service_type,
    task_status,
    active,
    base_amount,
    assignment_status,
    start_epoch,
    end_epoch,
    created_at
  )
  VALUES (
    $1,$2,$3::date,$4::date,$5,$6,$7,
    'NOT_STARTED',true,$8,$9,$10,$11,NOW()
  )
  RETURNING *
  `,
  [
    customerid,
    providerId,
    start_date,
    effectiveEndDate,   // ✅ IMPORTANT
    responsibilities,
    booking_type,
    service_type,
    base_amount,
    assignment_status,
    startEpoch,
    endEpoch,
  ]
);


    const engagement = engRes.rows[0];

    // 6️⃣ Create service_days ONLY for non-ON_DEMAND
    if (booking_type !== "ON_DEMAND") {
      await createServiceDays(client, engagement.engagement_id, start_date, effectiveEndDate);
    }

    // 7️⃣ Provider availability ONLY for non-ON_DEMAND
    if (providerId && booking_type !== "ON_DEMAND") {
      const startD = new Date(start_date);
      const endD = new Date(effectiveEndDate);


      for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
        const day = d.toISOString().slice(0, 10);
        const dayStartEpoch = toEpochSeconds(day, start_time);
        const dayEndEpoch = dayStartEpoch + hoursToAdd * 3600;

        await client.query(
          `
          INSERT INTO provider_availability
          (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
          VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())
          `,
          [providerId, engagement.engagement_id, day, dayStartEpoch, dayEndEpoch]
        );
      }
    }

    // 8️⃣ Payment (PENDING)
    const platform_fee = Number(base_amount) * 0.1;
    const gst = platform_fee * 0.18;
    const total_amount = Number(base_amount) + platform_fee + gst;

    let razorpay_order_id = null;
    if (payment_mode === "razorpay") {
      const order = await razorpay.orders.create({
        amount: Math.round(total_amount * 100),
        currency: "INR",
        receipt: `eng_${engagement.engagement_id}`,
      });
      razorpay_order_id = order.id;
    }

    const paymentRes = await client.query(
      `
      INSERT INTO payments
      (engagement_id, base_amount, platform_fee, gst, total_amount, payment_mode, status, razorpay_order_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,NOW())
      RETURNING *
      `,
      [
        engagement.engagement_id,
        base_amount,
        platform_fee,
        gst,
        total_amount,
        payment_mode,
        razorpay_order_id,
      ]
    );

    await client.query("COMMIT");

    

   if (!providerId && latitude && longitude) {
  const providerRes = await pool.query(`
    SELECT serviceproviderid, latitude, longitude
    FROM serviceprovider
    WHERE isactive = true
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
  `);

  const nearbyProviders = providerRes.rows.filter((p) => {
    const distance = geolib.getDistance(
      { latitude, longitude },
      { latitude: p.latitude, longitude: p.longitude }
    );
    return distance <= 5000;
  });

  console.log("Nearby providers found:", nearbyProviders.length);

  // for (const p of nearbyProviders) {
  //   const room = `provider_${p.serviceproviderid}`;

  //   const sockets = await req.io.in(room).fetchSockets();

  //   console.log(`📡 ${room} sockets:`, sockets.length);

  //   if (sockets.length > 0) {
  //     req.io.to(room).emit("new-engagement", {
  //       engagement: {
  //         engagement_id: engagement.engagement_id,
  //         service_type,
  //         booking_type,
  //         start_date,
  //         end_date,
  //         start_time,
  //         base_amount,
  //       },
  //     });

  //     console.log(`🚀 Notification sent to ${room}`);
  //   }
  // }
}


    // 🔟 Response
    return res.status(201).json({
      message: "Engagement created successfully",
      engagement,
      payment: paymentRes.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create engagement error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


// GET all engagements for a customer (FULL VERSION)
// Includes: provider details, payments, modifications, vacations, epoch times

router.get("/:customerId/engagements", async (req, res) => {
  try {
    const { customerId } = req.params;

    // ---- Fetch all engagements ----
    const engagementsRes = await pool.query(
      `SELECT * FROM engagements WHERE customerid=$1 ORDER BY start_date ASC`,
      [customerId]
    );

    if (engagementsRes.rows.length === 0) {
      return res.json({ upcoming: [], ongoing: [], past: [] });
    }

    const engagements = engagementsRes.rows;
    const engagementIds = engagements.map(e => e.engagement_id);

    // ---- Fetch today's service days ----
    const todayServiceRes = await pool.query(
      `
      SELECT
        service_day_id,
        engagement_id,
        status,
        started_at,
        completed_at
      FROM service_days
      WHERE engagement_id = ANY($1)
        AND service_date = CURRENT_DATE
      `,
      [engagementIds]
    );

    const todayServiceByEng = {};
    todayServiceRes.rows.forEach(sd => {
      todayServiceByEng[sd.engagement_id] = sd;
    });

    // ---- Fetch active OTPs ----
    const serviceDayIds = todayServiceRes.rows.map(s => s.service_day_id);
    const otpByServiceDay = {};

    if (serviceDayIds.length > 0) {
      const otpRes = await pool.query(
        `
        SELECT service_day_id
        FROM service_day_otps
        WHERE service_day_id = ANY($1)
          AND verified_at IS NULL
          AND expires_at > NOW()
        `,
        [serviceDayIds]
      );

      otpRes.rows.forEach(o => {
        otpByServiceDay[o.service_day_id] = true;
      });
    }

    // ---- Fetch modifications ----
    const modRes = await pool.query(
      `SELECT engagement_id, modified_at, modified_fields
       FROM engagement_modifications
       WHERE engagement_id = ANY($1)
       ORDER BY modified_at DESC`,
      [engagementIds]
    );

    // ---- Fetch payments ----
    const paymentsRes = await pool.query(
      `SELECT engagement_id, base_amount, platform_fee, gst, total_amount,
              payment_mode, status, created_at
       FROM payments
       WHERE engagement_id = ANY($1)`,
      [engagementIds]
    );

    // ---- Fetch provider details ----
    const providerIds = engagements.map(e => e.serviceproviderid).filter(Boolean);
    const providerRes = await pool.query(
      `SELECT
  "serviceproviderid",
  "firstName",
  "lastName",
  "rating"
FROM "serviceprovider"
WHERE "serviceproviderid" = ANY($1)`,
      [providerIds]
    );

    // ---- Maps ----
    const providerById = {};
    providerRes.rows.forEach(p => providerById[p.serviceproviderid] = p);

    const paymentByEng = {};
    paymentsRes.rows.forEach(p => paymentByEng[p.engagement_id] = p);

    const modsByEng = {};
    const vacationsByEng = {};

    modRes.rows.forEach(mod => {
      const parsed =
        typeof mod.modified_fields === "string"
          ? JSON.parse(mod.modified_fields)
          : mod.modified_fields;

      if (!modsByEng[mod.engagement_id]) modsByEng[mod.engagement_id] = [];
      if (!vacationsByEng[mod.engagement_id]) vacationsByEng[mod.engagement_id] = [];

      let action = "Modified";
      if (parsed?.modification_type === "VACATION_ADDED") action = "Vacation Applied";
      if (parsed?.modification_type === "VACATION_MODIFIED") action = "Vacation Updated";
      if (parsed?.modification_type === "VACATION_CANCELLED") action = "Vacation Cancelled";

      modsByEng[mod.engagement_id].push({
        date: mod.modified_at,
        action,
        refund: parsed?.updated?.refund ?? parsed?.wallet_effect?.customer_credit ?? null,
        penalty: parsed?.wallet_effect?.customer_debit ?? parsed?.updated?.penalty ?? null,
      });

      if (parsed?.modification_type?.startsWith("VACATION")) {
        vacationsByEng[mod.engagement_id].push({
          start_date: parsed?.updated?.vacation_start_date,
          end_date: parsed?.updated?.vacation_end_date,
          leave_days: parsed?.updated?.leave_days,
          refund: parsed?.updated?.refund,
          penalty: parsed?.updated?.penalty,
          action,
          applied_on: mod.modified_at,
        });
      }
    });

    // ---- Group engagements ----
    const now = dayjs().unix();
    const upcoming = [];
    const ongoing = [];
    const past = [];

    const today = dayjs().tz("Asia/Kolkata").startOf("day");

    engagements.forEach(e => {
      const engagementStart = dayjs(e.start_date).startOf("day");
      const engagementEnd = dayjs(e.end_date).endOf("day");

      const todayService = todayServiceByEng[e.engagement_id] || null;

  let today_service = null;
  if (todayService) {
    today_service = {
      service_day_id: todayService.service_day_id,
      status: todayService.status,
      can_start: todayService.status === "SCHEDULED",
      can_generate_otp: todayService.status === "IN_PROGRESS",
      can_complete: todayService.status === "IN_PROGRESS",
      otp_active: !!otpByServiceDay[todayService.service_day_id]
    };
  }

  const enriched = {
    ...e,
    start_time: dayjs.unix(e.start_epoch).tz("Asia/Kolkata").format("HH:mm"),
    end_time: dayjs.unix(e.end_epoch).tz("Asia/Kolkata").format("HH:mm"),
    provider: providerById[e.serviceproviderid] || null,
    payment: paymentByEng[e.engagement_id] || null,
    modifications: modsByEng[e.engagement_id] || [],
    vacations: vacationsByEng[e.engagement_id] || [],
    today_service
  };

  if (today.isBefore(engagementStart)) {
    upcoming.push(enriched);
  } else if (today.isAfter(engagementEnd)) {
    past.push(enriched);
  } else {
    ongoing.push(enriched);
  }
});

    return res.json({ upcoming, ongoing, past });

  } catch (err) {
    console.error("GET engagements error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});




// ----------------- PUT /:id — update engagement (supports time/provider/date changes & vacation) -----------------
//
// Supports:
// - updating start_date, end_date, start_time (recomputes epochs & availability)
// - changing serviceproviderid (reassign provider) — will check availability/conflicts
// - applying/modifying/cancelling vacation (see fields below)
// - updating other fields: responsibilities, booking_type, service_type, base_amount, task_status, active
//
// Vacation-specific fields (in body):
//  - vacation_start_date (YYYY-MM-DD)
//  - vacation_end_date   (YYYY-MM-DD)
//  - cancel_vacation (boolean)
//  - modified_by_id, modified_by_role
//
// Note: business rules you confirmed:
//  - refund = dailyRate * leaveDays
//  - penalty = 400 when modifying existing vacation
//
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;
  try {
    await client.query("BEGIN");

    // Lock engagement row
    const engRow = await client.query(`SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`, [id]);
    if (engRow.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Engagement not found" }); }
    const oldEng = engRow.rows[0];

    const providerBefore = oldEng.serviceproviderid;
    const customerId = oldEng.customerid;

    // ensure wallets exist
    const customerWalletId = await getCustomerWalletId(client, customerId);
    await ensureProviderWallet(client, providerBefore);

    // Extract body
    const body = req.body || {};
    const {
      start_date,
      end_date,
      start_time,
      serviceproviderid,
      responsibilities,
      booking_type,
      service_type,
      base_amount,
      task_status,
      active,
      vacation_start_date,
      vacation_end_date,
      cancel_vacation,
      modified_by_id,
      modified_by_role
    } = body;

    const isVacationOperation = (vacation_start_date !== undefined) || (vacation_end_date !== undefined) || (cancel_vacation);

    // If it's a non-vacation update that can include changing time/provider/dates -> handle separately
    if (!isVacationOperation) {
      // Build update set
      const setClauses = [];
      const values = [];
      let idx = 1;

      // fields allowed to update (including changing provider/time/date)
      const mapping = {
        start_date: { cast: '::date' },
        end_date: { cast: '::date' },
        responsibilities: { json: true },
        booking_type: {},
        service_type: {},
        task_status: {},
        active: {},
        base_amount: {},
        serviceproviderid: {},
      };

      for (const f of Object.keys(mapping)) {
        if (body[f] !== undefined) {
          if (f === 'responsibilities') {
            setClauses.push(`${f} = $${idx++}`);
            values.push(JSON.stringify(body[f]));
          } else {
            setClauses.push(`${f} = $${idx++}`);
            values.push(body[f]);
          }
        }
      }

      // handle time/date -> recompute epochs and update provider_availability accordingly
      let newStartEpoch = oldEng.start_epoch;
      let newEndEpoch = oldEng.end_epoch;
      let newStartDate = oldEng.start_date;
      let newEndDate = oldEng.end_date;
      let newProviderId = (body.serviceproviderid !== undefined) ? body.serviceproviderid : oldEng.serviceproviderid;
      let newStartTimeStr = start_time || epochToTimeHM(oldEng.start_epoch);

      if ((start_date && start_time) || (start_date && !start_time && oldEng.start_epoch)) {
        // we have a new start_date and possibly start_time -> compute newStartEpoch
        const timeForStart = start_time || epochToTimeHM(oldEng.start_epoch);
        newStartEpoch = toEpochSeconds(start_date, timeForStart);
        newStartDate = start_date;
      } else if (start_time && !start_date) {
        // change only time; date stays same
        const timeForStart = start_time;
        newStartEpoch = toEpochSeconds(oldEng.start_date.toISOString ? oldEng.start_date.toISOString().slice(0,10) : oldEng.start_date, timeForStart);
        newStartDate = normalizeDateToIST(oldEng.start_date);
      }

      if ((end_date && start_time) || (end_date && !start_time && oldEng.end_epoch)) {
        const timeForEnd = start_time || epochToTimeHM(oldEng.end_epoch);
        // endEpoch computed by adding duration (we preserve original duration)
        // original duration:
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        newEndEpoch = (newStartEpoch) ? newStartEpoch + origDur : oldEng.end_epoch;
        newEndDate = end_date;
      } else if (end_date && !start_time) {
        // date changed only: shift end accordingly preserving time
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        const startForNew = toEpochSeconds(end_date, epochToTimeHM(oldEng.start_epoch));
        newEndEpoch = startForNew + origDur;
        newEndDate = end_date;
      } else if (start_time && !end_date && !start_date) {
        // only time changed -> shift end as well preserving duration
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        const startForNew = toEpochSeconds(normalizeDateToIST(oldEng.start_date), start_time);
        newStartEpoch = startForNew;
        newEndEpoch = startForNew + origDur;
      }

      // If provider changed, validate new provider
      if (newProviderId && newProviderId !== providerBefore) {
        const provCheck = await client.query(`SELECT 1 FROM serviceprovider WHERE serviceproviderid=$1`, [newProviderId]);
        if (provCheck.rows.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "New provider not found" }); }
        await ensureProviderWallet(client, newProviderId);
      }

      // Overlap checks for new provider/time/dates: check each daily slot that would be created
      // Build list of dates for new availability
      const startDateOnly = newStartDate ? new Date(newStartDate) : new Date(oldEng.start_date);
      const endDateOnly = newEndDate ? new Date(newEndDate) : new Date(oldEng.end_date);
      const dateList = enumerateDates(startDateOnly, endDateOnly);

      // compute representative daily slot times (HH:mm) from newStartEpoch
      const dailyStartTime = epochToTimeHM(newStartEpoch);
      const dailyEndTime = epochToTimeHM(newEndEpoch);

      // check conflicts for each day if provider assigned
      if (newProviderId) {
        for (const day of dateList) {
          const dayStart = toEpochSeconds(day, dailyStartTime);
          const dayEnd = dayStart + (Number(newEndEpoch) - Number(newStartEpoch));
          const conflict = await client.query(
            `SELECT engagement_id FROM provider_availability
             WHERE serviceproviderid=$1
               AND $2 < slot_end_epoch
               AND $3 > slot_start_epoch
               AND engagement_id != $4
             LIMIT 1`,
            [newProviderId, dayStart, dayEnd, id]
          );
          if (conflict.rows.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "Time overlap with another engagement for the provider", conflict: conflict.rows[0] });
          }
        }
      }

      // --- Proceed update: update provider_availability (free old provider slots, insert or update new provider slots)
      // Free old provider availability rows (for the engagement)
      if (providerBefore) {
        await client.query(`UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1`, [id]);
      }

      // Insert/Update availability for new provider (daily)
      if (newProviderId) {
        const origDur = (oldEng.end_epoch && oldEng.start_epoch) ? (Number(oldEng.end_epoch) - Number(oldEng.start_epoch)) : 3600;
        // clear any existing rows for engagement for new provider's dates (defensive)
        for (const day of dateList) {
          const ds = toEpochSeconds(day, dailyStartTime);
          const de = ds + origDur;
          // if a row exists for this engagement & day -> update, else insert
          const exists = await client.query(
            `SELECT 1 FROM provider_availability WHERE engagement_id=$1 AND date=$2::date LIMIT 1`,
            [id, day]
          );
          if (exists.rows.length > 0) {
            await client.query(
              `UPDATE provider_availability
               SET serviceproviderid=$1, slot_start_epoch=$2, slot_end_epoch=$3, status='BOOKED', updated_at=NOW()
               WHERE engagement_id=$4 AND date=$5::date`,
              [newProviderId, ds, de, id, day]
            );
          } else {
            await client.query(
              `INSERT INTO provider_availability
                (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
               VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())`,
              [newProviderId, id, day, ds, de]
            );
          }
        }
      }

      // Now update engagements table with new computed epoch and provider if provided
      if (setClauses.length > 0) {
        values.push(id);
        await client.query(`UPDATE engagements SET ${setClauses.join(", ")} WHERE engagement_id=$${values.length}`, values);
      }

      // update epoch/date/provider fields explicitly if they changed
      const updateFields = [];
      const updateVals = [];
      let uIdx = 1;
      if (newStartEpoch !== oldEng.start_epoch) {
        updateFields.push(`start_epoch = $${uIdx++}`); updateVals.push(newStartEpoch);
      }
      if (newEndEpoch !== oldEng.end_epoch) {
        updateFields.push(`end_epoch = $${uIdx++}`); updateVals.push(newEndEpoch);
      }
      if (newStartDate && newStartDate !== oldEng.start_date) {
        updateFields.push(`start_date = $${uIdx++}::date`); updateVals.push(newStartDate);
      }
      if (newEndDate && newEndDate !== oldEng.end_date) {
        updateFields.push(`end_date = $${uIdx++}::date`); updateVals.push(newEndDate);
      }
      if (newProviderId !== providerBefore) {
        updateFields.push(`serviceproviderid = $${uIdx++}`); updateVals.push(newProviderId);
      }

      if (updateFields.length > 0) {
        updateVals.push(id);
        await client.query(`UPDATE engagements SET ${updateFields.join(", ")} WHERE engagement_id=$${updateVals.length}`, updateVals);
      }

      // Log modification
      await client.query(
        `INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
         VALUES ($1,$2::jsonb,$3,$4,NOW())`,
        [id, JSON.stringify({ updated_fields: body }), modified_by_id || null, modified_by_role || null]
      );

      await client.query("COMMIT");

      // return updated row
      const updated = (await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])).rows[0];
      updated.start_date = normalizeDateToIST(updated.start_date);
      updated.end_date = normalizeDateToIST(updated.end_date);
      updated.start_time = epochToTimeHM(updated.start_epoch);
      updated.end_time = epochToTimeHM(updated.end_epoch);
      return res.json({ message: "Engagement updated", engagement: updated });
    }

    // ---------- Vacation specific flows ----------
    // lock provider_availability rows for this engagement (we will update them)
    await ensureProviderWallet(client, providerBefore);

    // fetch previous vacation info
    const prevVacStart = oldEng.vacation_start_date ? new Date(oldEng.vacation_start_date) : null;
    const prevVacEnd = oldEng.vacation_end_date ? new Date(oldEng.vacation_end_date) : null;
    const prevDates = (prevVacStart && prevVacEnd) ? enumerateDates(prevVacStart, prevVacEnd) : [];

    // CANCEL vacation
    if (cancel_vacation) {
      if (prevDates.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "No existing vacation to cancel" }); }

      // compute refund revert (customer to be debited, provider credited)
      const dailyRate = computeDailyRate(oldEng.base_amount, oldEng.start_date, oldEng.end_date);
      const refundToRevert = (oldEng.leave_days || prevDates.length) * dailyRate;

      // ensure provider has availability free on those dates (no other engagements)
      await client.query(`SELECT 1 FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) FOR UPDATE`, [providerBefore, prevDates]);
      const conflicts = await client.query(
        `SELECT engagement_id, date FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) AND engagement_id != $3 AND status='BOOKED'`,
        [providerBefore, prevDates, id]
      );
      if (conflicts.rows.length > 0) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Cannot cancel vacation; provider is booked on some previously-vacation dates", conflicts: conflicts.rows }); }

      // wallet ops: debit customer, credit provider
      await client.query(`UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`, [refundToRevert, customerWalletId]);
      await client.query(`INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type) VALUES ($1,$2,$3,'DEBIT')`, [customerWalletId, id, refundToRevert]);

      await client.query(`UPDATE provider_wallets SET balance = balance + $1 WHERE serviceproviderid=$2`, [refundToRevert, providerBefore]);
      await client.query(`UPDATE payouts SET net_amount = net_amount + $1 WHERE engagement_id=$2`, [refundToRevert, id]);

      // restore provider availability rows (set to BOOKED)
      await client.query(`UPDATE provider_availability SET status='BOOKED' WHERE engagement_id=$1 AND date = ANY($2)`, [id, prevDates]);

      // update engagement
      await client.query(`UPDATE engagements SET vacation_start_date=NULL, vacation_end_date=NULL, leave_days=0 WHERE engagement_id=$1`, [id]);

      // audit
      const audit = {
        modification_type: "VACATION_CANCELLED",
        previous: { vacation_start_date: prevVacStart ? prevVacStart.toISOString().slice(0,10) : null, vacation_end_date: prevVacEnd ? prevVacEnd.toISOString().slice(0,10) : null, leave_days: prevDates.length },
        updated: null,
        wallet_effect: { customer_debit: refundToRevert, provider_credit: refundToRevert }
      };
      await client.query(`INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at) VALUES ($1,$2::jsonb,$3,$4,NOW())`, [id, JSON.stringify(audit), modified_by_id || null, modified_by_role || null]);

      await client.query("COMMIT");
      const updated = (await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])).rows[0];
      updated.start_date = normalizeDateToIST(updated.start_date);
      updated.end_date = normalizeDateToIST(updated.end_date);
      updated.start_time = epochToTimeHM(updated.start_epoch);
      updated.end_time = epochToTimeHM(updated.end_epoch);
      return res.json({ message: "Vacation cancelled", engagement: updated });
    }

    // APPLY or MODIFY vacation
    if (!vacation_start_date || !vacation_end_date) {
      await client.query("ROLLBACK"); return res.status(400).json({ error: "Both vacation_start_date and vacation_end_date are required" });
    }

    const vacStart = new Date(vacation_start_date);
    const vacEnd = new Date(vacation_end_date);
    if (vacStart > vacEnd) { await client.query("ROLLBACK"); return res.status(400).json({ error: "vacation_start_date must be <= vacation_end_date" }); }

    // ensure vacation within engagement bounds
    const engStart = new Date(oldEng.start_date);
    const engEnd = new Date(oldEng.end_date);
    if (vacStart < engStart || vacEnd > engEnd) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Vacation dates must fall within engagement start/end dates" }); }

    const newDates = enumerateDates(vacStart, vacEnd);
    const restoredDates = prevDates.filter(d => !newDates.includes(d)); // dates being restored (previously vacation, now active)
    const freedDates = newDates.filter(d => !prevDates.includes(d)); // dates that become vacation (become free)

    // If restoredDates exist -> check provider availability conflicts & time overlaps
    if (restoredDates.length > 0) {
      // compute daily start time (HH:mm) from engagement epochs
      const checkStartTime = epochToTimeHM(oldEng.start_epoch);
      const checkEndTime = epochToTimeHM(oldEng.end_epoch);
      if (!checkStartTime || !checkEndTime) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Missing start/end time for overlap checks" }); }

      // lock candidate rows
      await client.query(`SELECT 1 FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) FOR UPDATE`, [providerBefore, restoredDates]);

      // check for booked conflicts
      const availConflicts = await client.query(
        `SELECT date, engagement_id FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) AND engagement_id != $3 AND status='BOOKED'`,
        [providerBefore, restoredDates, id]
      );
      if (availConflicts.rows.length > 0) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Provider is already booked on some restored dates", conflicts: availConflicts.rows }); }

      // time overlap check using epoch math per day
      for (const day of restoredDates) {
        const dayStartEpoch = toEpochSeconds(day, checkStartTime);
        const dayEndEpoch = toEpochSeconds(day, checkEndTime);
        if (!dayStartEpoch || !dayEndEpoch || dayStartEpoch >= dayEndEpoch) { await client.query("ROLLBACK"); return res.status(400).json({ error: `Invalid computed time range for date ${day}` }); }

        const timeConflict = await client.query(
          `SELECT engagement_id, date FROM provider_availability WHERE serviceproviderid=$1 AND date=$2::date AND engagement_id != $3 AND $4 < slot_end_epoch AND $5 > slot_start_epoch LIMIT 1`,
          [providerBefore, day, id, dayStartEpoch, dayEndEpoch]
        );
        if (timeConflict.rows.length > 0) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Time overlap with other engagements on restored dates", conflict: timeConflict.rows[0] }); }
      }
    }

    // compute refund and penalty
    const dailyRate = computeDailyRate(oldEng.base_amount, oldEng.start_date, oldEng.end_date);
    const prevLeaveDays = oldEng.leave_days || prevDates.length || 0;
    const newLeaveDays = newDates.length;
    const refundAmount = newLeaveDays * dailyRate;
    let penalty = 0;
    if (prevLeaveDays > 0) penalty = 400; // business rule confirmed

    // apply penalty (debit customer)
    if (penalty > 0) {
      await client.query(`UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`, [penalty, customerWalletId]);
      await client.query(`INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type) VALUES ($1,$2,$3,'DEBIT')`, [customerWalletId, id, penalty]);
    }

    // credit refund to customer
    await client.query(`UPDATE customer_wallets SET balance = balance + $1 WHERE wallet_id=$2`, [refundAmount, customerWalletId]);
    await client.query(`INSERT INTO wallet_transaction (wallet_id, engagement_id, amount, transaction_type) VALUES ($1,$2,$3,'CREDIT')`, [customerWalletId, id, refundAmount]);

    // deduct provider payout & adjust payouts
    await client.query(`UPDATE provider_wallets SET balance = balance - $1 WHERE serviceproviderid=$2`, [refundAmount, providerBefore]);
    await client.query(`UPDATE payouts SET net_amount = net_amount - $1 WHERE engagement_id=$2`, [refundAmount, id]);

    // Update provider_availability rows:
    // restoredDates -> BOOKED (update slot epochs as required), freedDates -> FREE
    if (restoredDates.length > 0) {
      // compute representative day epoch times
      const repStartTime = epochToTimeHM(oldEng.start_epoch);
      const repEndTime = epochToTimeHM(oldEng.end_epoch);
      for (const day of restoredDates) {
        const ds = toEpochSeconds(day, repStartTime);
        const de = toEpochSeconds(day, repEndTime);
        await client.query(`UPDATE provider_availability SET status='BOOKED', slot_start_epoch=$1, slot_end_epoch=$2 WHERE engagement_id=$3 AND date=$4::date`, [ds, de, id, day]);
      }
    }
    if (freedDates.length > 0) {
      for (const day of freedDates) {
        await client.query(`UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1 AND date=$2::date`, [id, day]);
      }
    }

    // Update engagement row with vacation info
    await client.query(`UPDATE engagements SET vacation_start_date=$1::date, vacation_end_date=$2::date, leave_days=$3 WHERE engagement_id=$4`, [vacation_start_date, vacation_end_date, newLeaveDays, id]);

    // Audit
    const auditEntry = {
      modification_type: prevDates.length === 0 ? "VACATION_ADDED" : "VACATION_MODIFIED",
      previous: prevDates.length > 0 ? { vacation_start_date: prevVacStart ? prevVacStart.toISOString().slice(0,10) : null, vacation_end_date: prevVacEnd ? prevVacEnd.toISOString().slice(0,10) : null, leave_days: prevDates.length } : null,
      updated: { vacation_start_date: vacation_start_date, vacation_end_date: vacation_end_date, leave_days: newLeaveDays, refund: refundAmount },
      difference: { days_added: Math.max(0, newLeaveDays - prevLeaveDays), days_removed: Math.max(0, prevLeaveDays - newLeaveDays), refund_change: refundAmount - (oldEng.refund || 0), penalty },
      wallet_effect: { customer_credit: refundAmount, customer_debit: penalty, provider_debit: refundAmount, payout_adjustment: -refundAmount },
      availability_changes: { dates_freed: freedDates, dates_rebooked: restoredDates }
    };

    await client.query(`INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at) VALUES ($1,$2::jsonb,$3,$4,NOW())`, [id, JSON.stringify(auditEntry), modified_by_id || null, modified_by_role || null]);

    await client.query("COMMIT");
    const updatedEng = (await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])).rows[0];
    updatedEng.start_date = normalizeDateToIST(updatedEng.start_date);
    updatedEng.end_date = normalizeDateToIST(updatedEng.end_date);
    updatedEng.start_time = epochToTimeHM(updatedEng.start_epoch);
    updatedEng.end_time = epochToTimeHM(updatedEng.end_epoch);

    return res.json({ message: "Vacation applied/modified successfully", engagement: updatedEng, audit: auditEntry });

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (e) {}
    console.error("Error updating engagement:", err);
    return res.status(500).json({ error: "Failed to update engagement", detail: err.message });
  } finally {
    client.release();
  }
});

// ----------------- Cancel engagement (simple) -----------------
router.patch("/:id/cancel", async (req, res) => {
  try {
    const result = await pool.query(`UPDATE engagements SET status='cancelled', updated_at=NOW() WHERE engagement_id=$1 RETURNING *`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Engagement not found" });
    // Mark provider availability FREE for this engagement
    await pool.query(`UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1`, [req.params.id]);
    return res.json({ message: "Engagement cancelled", engagement: result.rows[0] });
  } catch (err) {
    console.error("Error cancelling engagement:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------- Accept endpoint (simple) -----------------
router.post("/:id/accept", async (req, res) => {
  const client = await pool.connect();

  try {
    const { serviceproviderid } = req.body;
    const { id } = req.params;

    if (!serviceproviderid) {
      return res.status(400).json({ error: "serviceproviderid is required" });
    }

    await client.query("BEGIN");

    // 1️⃣ Lock engagement
    const engRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`,
      [id]
    );

    if (engRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Engagement not found" });
    }

    const e = engRes.rows[0];

    if (e.assignment_status !== "UNASSIGNED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Engagement already assigned" });
    }

    if (!e.start_epoch || !e.end_epoch) {
      throw new Error("Engagement start/end time missing");
    }

    const duration = Number(e.end_epoch) - Number(e.start_epoch);

    // 2️⃣ Provider availability check (single slot)
    const conflict = await client.query(
      `
      SELECT 1
      FROM provider_availability
      WHERE serviceproviderid=$1
        AND $2 < slot_end_epoch
        AND $3 > slot_start_epoch
      LIMIT 1
      `,
      [serviceproviderid, e.start_epoch, e.end_epoch]
    );

    if (conflict.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Provider has time conflict" });
    }

    // 3️⃣ Assign provider
    await client.query(
      `
      UPDATE engagements
      SET serviceproviderid=$1,
          assignment_status='ASSIGNED'
      WHERE engagement_id=$2
      `,
      [serviceproviderid, id]
    );

    // 4️⃣ Create provider availability (ONE row)
    await client.query(
      `
      INSERT INTO provider_availability
      (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
      VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())
      `,
      [
        serviceproviderid,
        id,
        e.start_date,
        e.start_epoch,
        e.end_epoch,
      ]
    );

    // 5️⃣ Create service_day (ONE row)
    await client.query(
      `
      INSERT INTO service_days
      (engagement_id, service_date, status, created_at)
      VALUES ($1,$2::date,'SCHEDULED',NOW())
      ON CONFLICT DO NOTHING
      `,
      [id, e.start_date]
    );

    await client.query("COMMIT");

    // 6️⃣ Return normalized response
    const updated = (
      await pool.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [id])
    ).rows[0];

    updated.start_time = epochToTimeHM(updated.start_epoch);
    updated.end_time = epochToTimeHM(updated.end_epoch);

    return res.json({
      message: "Engagement accepted successfully",
      engagement: updated,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Accept engagement error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


function getDateRange(startDate, endDate) {
  const dates = [];

  let current = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");

  while (current <= end) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}










export default router;
