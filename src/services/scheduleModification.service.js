import pool from "../config/db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { createHmac } from "crypto";
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret } from "../utils/razorpayConfig.js";
import {
  findProviderBookedConflict,
  visitDurationSecondsFromEngagement,
} from "./providerAvailabilityOverlap.js";
import { computeModificationPlatformCharge } from "./modificationPlatformCharge.js";
import {
  computeWalletApplication,
  deductWalletForPayment,
  getCustomerWalletBalance,
  ensureCustomerWalletForUpdate,
} from "./customerWallet.service.js";

function roundInr(value) {
  return Math.round(Number(value) * 100) / 100;
}

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

function toEpochSeconds(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dt = dayjs.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
  if (!dt.isValid()) return null;
  return dt.unix();
}

function toFiniteEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function dateYmdFromEpoch(epochSeconds) {
  const epoch = toFiniteEpoch(epochSeconds);
  if (epoch == null) return null;
  return dayjs.unix(epoch).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

function normalizeYmdInput(dateLike) {
  if (!dateLike) return null;
  if (typeof dateLike === "string") {
    const trimmed = dateLike.trim();
    const strict = dayjs.tz(trimmed.slice(0, 10), "YYYY-MM-DD", "Asia/Kolkata");
    if (strict.isValid()) return strict.format("YYYY-MM-DD");
    const parsed = dayjs.tz(trimmed, "Asia/Kolkata");
    if (parsed.isValid()) return parsed.format("YYYY-MM-DD");
    return null;
  }
  const parsed = dayjs(dateLike).tz("Asia/Kolkata");
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
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
  const endDate = new Date(end);
  while (cur <= endDate) {
    res.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return res;
}

async function ensureProviderWallet(client, providerId) {
  if (!providerId) return null;
  const walletRes = await client.query(
    `SELECT * FROM provider_wallets WHERE serviceproviderid=$1`,
    [providerId]
  );
  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(
      `INSERT INTO provider_wallets (serviceproviderid, balance, security_deposit_collected) VALUES ($1,0,0) RETURNING *`,
      [providerId]
    );
    return insertRes.rows[0];
  }
  return walletRes.rows[0];
}

function resolveBookingBaseAmount(engagement, paymentRow) {
  const fromEng = Number(engagement?.base_amount);
  if (Number.isFinite(fromEng) && fromEng > 0) return fromEng;
  const fromPay = Number(paymentRow?.base_amount);
  if (Number.isFinite(fromPay) && fromPay > 0) return fromPay;
  return 0;
}

async function resolveOriginalBookingPayment(client, engagementId) {
  const res = await client.query(
    `SELECT payment_id, base_amount, platform_fee, gst, total_amount, status
     FROM payments
     WHERE engagement_id = $1
       AND UPPER(COALESCE(status, '')) = 'SUCCESS'
       AND COALESCE(base_amount, 0) > 0
     ORDER BY payment_id ASC
     LIMIT 1`,
    [engagementId]
  );
  return res.rows[0] || null;
}

/**
 * Clear abandoned modification checkout (e.g. user closed Razorpay) so they can retry.
 */
async function cleanupAbandonedScheduleModificationAttempts(client, engagementId, customerId) {
  // Use NOWAIT to fail fast instead of waiting for locks (prevents deadlock chains)
  const pendingPayRes = await client.query(
    `SELECT payment_id, wallet_amount, wallet_deducted
     FROM payments
     WHERE engagement_id = $1
       AND UPPER(COALESCE(status, '')) = 'PENDING'
       AND COALESCE(base_amount, 0) = 0
       AND COALESCE(platform_fee, 0) > 0
     FOR UPDATE NOWAIT`,
    [engagementId]
  ).catch(err => {
    // If we can't get the lock immediately, another process is handling it
    if (err.code === '55P03') { // lock_not_available
      console.log(`[cleanup] Skipping - another process is cleaning up engagement ${engagementId}`);
      return { rows: [] };
    }
    throw err;
  });

  for (const pay of pendingPayRes.rows) {
    const walletAmt = roundInr(pay.wallet_amount ?? 0);
    if (walletAmt > 0 && pay.wallet_deducted) {
      const wallet = await ensureCustomerWalletForUpdate(client, customerId);
      const balanceAfter = roundInr(wallet.balance + walletAmt);
      await client.query(
        `UPDATE customer_wallets SET balance = $1, updated_at = NOW() WHERE wallet_id = $2`,
        [balanceAfter, wallet.wallet_id]
      );
      await client.query(
        `INSERT INTO wallet_transaction
           (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
         VALUES ($1, $2, $3, $4, 'CREDIT', $5, $6)`,
        [
          wallet.wallet_id,
          customerId,
          engagementId,
          walletAmt,
          `Refund: modification payment cancelled (booking #${engagementId})`,
          balanceAfter,
        ]
      );
    }
    await client.query(
      `UPDATE payments SET status = 'CANCELLED', updated_at = NOW() WHERE payment_id = $1`,
      [pay.payment_id]
    );
  }

  await client.query(
    `UPDATE engagement_modifications em
     SET modification_type = 'SCHEDULE_MODIFICATION_CANCELLED'
     FROM payments p
     WHERE em.engagement_id = $1
       AND em.modification_type = 'SCHEDULE_MODIFICATION_PENDING'
       AND (em.modified_fields->>'modification_payment_id')::bigint = p.payment_id
       AND UPPER(COALESCE(p.status, '')) = 'PENDING'
       AND COALESCE(p.base_amount, 0) = 0
       AND COALESCE(p.platform_fee, 0) > 0`,
    [engagementId]
  );
}

export function isScheduleModificationPayment(payment) {
  return (
    Number(payment?.base_amount ?? 0) === 0 && Number(payment?.platform_fee ?? 0) > 0
  );
}

function parseModifiedFields(modifiedFields) {
  return typeof modifiedFields === "string" ? JSON.parse(modifiedFields) : modifiedFields;
}

function scheduleAlreadyMatches(eng, schedulePayload) {
  if (!schedulePayload || !eng) return false;
  const expectedStart = normalizeYmdInput(schedulePayload.start_date);
  const expectedEnd = normalizeYmdInput(schedulePayload.end_date);
  const currentStart = normalizeYmdInput(eng.start_date);
  const currentEnd = normalizeYmdInput(eng.end_date);
  if (expectedStart && currentStart !== expectedStart) return false;
  if (expectedEnd && currentEnd !== expectedEnd) return false;
  if (schedulePayload.start_time && epochToTimeHM(eng.start_epoch) !== schedulePayload.start_time) {
    return false;
  }
  if (schedulePayload.end_time && epochToTimeHM(eng.end_epoch) !== schedulePayload.end_time) {
    return false;
  }
  return true;
}

export async function getModificationFeeQuote(engagementId) {
  const engRes = await pool.query(
    `SELECT e.engagement_id, e.base_amount, e.booking_type, e.service_type, e.engagement_status
     FROM engagements e
     WHERE e.engagement_id = $1`,
    [engagementId]
  );
  if (!engRes.rows.length) {
    const err = new Error("Engagement not found");
    err.statusCode = 404;
    throw err;
  }
  const engagement = engRes.rows[0];
  const life = String(engagement.engagement_status || "").toUpperCase();
  const task = String(engagement.task_status || "").toUpperCase();
  if (life === "CANCELLED" || task === "CANCELLED") {
    const err = new Error("Cancelled bookings cannot be modified");
    err.statusCode = 400;
    throw err;
  }

  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query("BEGIN");
    await cleanupAbandonedScheduleModificationAttempts(
      cleanupClient,
      engagementId,
      engagement.customerid
    );
    await cleanupClient.query("COMMIT");
  } catch (cleanupErr) {
    await cleanupClient.query("ROLLBACK");
    throw cleanupErr;
  } finally {
    cleanupClient.release();
  }

  const payment = await resolveOriginalBookingPayment(pool, engagementId);
  if (!payment) {
    const err = new Error("Original booking payment must be completed before modifying schedule");
    err.statusCode = 400;
    throw err;
  }
  const booking_base = resolveBookingBaseAmount(engagement, payment);
  const fee = computeModificationPlatformCharge(booking_base);
  return {
    engagement_id: Number(engagementId),
    booking_type: engagement.booking_type,
    service_type: engagement.service_type,
    booking_base: fee.booking_base,
    platform_fee: fee.platform_fee,
    gst: fee.gst,
    taxes_and_fees: fee.taxes_and_fees,
    total_amount: fee.total_amount,
    platform_fee_rate: 0.06,
    gst_rate: 0,
    original_payment: payment
      ? {
          base_amount: Number(payment.base_amount),
          total_amount: Number(payment.total_amount),
          status: payment.status,
        }
      : null,
  };
}

/**
 * Apply schedule date/time update (same rules as PUT /api/engagements/:id non-vacation branch).
 */
export async function applyEngagementScheduleUpdate(client, engagementId, body) {
  // Use NOWAIT to fail fast if another transaction is modifying this engagement
  const engRow = await client.query(
    `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE NOWAIT`,
    [engagementId]
  ).catch(err => {
    if (err.code === '55P03') { // lock_not_available
      const error = new Error("This booking is currently being modified by another process. Please try again in a moment.");
      error.statusCode = 409;
      throw error;
    }
    throw err;
  });
  
  if (!engRow.rows.length) {
    const err = new Error("Engagement not found");
    err.statusCode = 404;
    throw err;
  }
  const oldEng = engRow.rows[0];
  const providerBefore = oldEng.serviceproviderid;

  const {
    start_date,
    end_date,
    start_time,
    end_time,
    start_epoch,
    end_epoch,
    start_date_epoch,
    end_date_epoch,
    serviceproviderid,
    modified_by_id,
    modified_by_role,
  } = body;

  const setClauses = [];
  const values = [];
  let idx = 1;
  const mapping = {
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
      if (f === "responsibilities") {
        setClauses.push(`${f} = $${idx++}`);
        values.push(JSON.stringify(body[f]));
      } else {
        setClauses.push(`${f} = $${idx++}`);
        values.push(body[f]);
      }
    }
  }

  let newStartEpoch = oldEng.start_epoch;
  let newEndEpoch = oldEng.end_epoch;
  let newStartDate = oldEng.start_date;
  let newEndDate = oldEng.end_date;
  let newProviderId =
    body.serviceproviderid !== undefined ? body.serviceproviderid : oldEng.serviceproviderid;

  const bodyStartEpoch = toFiniteEpoch(start_epoch);
  const bodyEndEpoch = toFiniteEpoch(end_epoch);
  const bodyStartDate = normalizeYmdInput(start_date) ?? dateYmdFromEpoch(start_date_epoch);
  const bodyEndDate = normalizeYmdInput(end_date) ?? dateYmdFromEpoch(end_date_epoch);

  if (bodyStartEpoch != null) {
    newStartEpoch = bodyStartEpoch;
    newStartDate = dateYmdFromEpoch(bodyStartEpoch) || newStartDate;
  }
  if (bodyEndEpoch != null) {
    newEndEpoch = bodyEndEpoch;
    newEndDate = dateYmdFromEpoch(bodyEndEpoch) || newEndDate;
  }
  if (bodyStartDate) {
    newStartDate = bodyStartDate;
    if (!bodyStartEpoch && (start_time || oldEng.start_epoch)) {
      const timeForStart = start_time || epochToTimeHM(oldEng.start_epoch);
      newStartEpoch = toEpochSeconds(bodyStartDate, timeForStart);
    }
  }
  if (bodyEndDate) {
    newEndDate = bodyEndDate;
  }

  if ((start_date && start_time) || (start_date && !start_time && oldEng.start_epoch)) {
    const timeForStart = start_time || epochToTimeHM(oldEng.start_epoch);
    newStartEpoch = toEpochSeconds(start_date, timeForStart);
    newStartDate = start_date;
  } else if (start_time && !start_date) {
    const timeForStart = start_time;
    newStartEpoch = toEpochSeconds(
      normalizeDateToIST(oldEng.start_date),
      timeForStart
    );
    newStartDate = normalizeDateToIST(oldEng.start_date);
  }

  if ((end_date && start_time) || (end_date && !start_time && oldEng.end_epoch)) {
    const origDur =
      oldEng.end_epoch && oldEng.start_epoch
        ? Number(oldEng.end_epoch) - Number(oldEng.start_epoch)
        : 3600;
    newEndEpoch = newStartEpoch ? newStartEpoch + origDur : oldEng.end_epoch;
    newEndDate = end_date;
  } else if (end_date && !start_time) {
    const origDur =
      oldEng.end_epoch && oldEng.start_epoch
        ? Number(oldEng.end_epoch) - Number(oldEng.start_epoch)
        : 3600;
    const startForNew = toEpochSeconds(end_date, epochToTimeHM(oldEng.start_epoch));
    newEndEpoch = startForNew + origDur;
    newEndDate = end_date;
  } else if (start_time && !end_date && !start_date) {
    const origDur =
      oldEng.end_epoch && oldEng.start_epoch
        ? Number(oldEng.end_epoch) - Number(oldEng.start_epoch)
        : 3600;
    const startForNew = toEpochSeconds(normalizeDateToIST(oldEng.start_date), start_time);
    newStartEpoch = startForNew;
    newEndEpoch = startForNew + origDur;
  }

  if (end_time && newStartEpoch) {
    const endDateForEpoch =
      newEndDate || normalizeDateToIST(oldEng.end_date) || normalizeDateToIST(oldEng.start_date);
    const endFromTime = toEpochSeconds(endDateForEpoch, end_time);
    if (endFromTime > newStartEpoch) {
      newEndEpoch = endFromTime;
    }
  }

  if (newProviderId && newProviderId !== providerBefore) {
    const provCheck = await client.query(
      `SELECT 1 FROM serviceprovider WHERE serviceproviderid=$1`,
      [newProviderId]
    );
    if (!provCheck.rows.length) {
      const err = new Error("New provider not found");
      err.statusCode = 400;
      throw err;
    }
    await ensureProviderWallet(client, newProviderId);
  }

  const startDateOnly = newStartDate ? new Date(newStartDate) : new Date(oldEng.start_date);
  const endDateOnly = newEndDate ? new Date(newEndDate) : new Date(oldEng.end_date);
  const dateList = enumerateDates(startDateOnly, endDateOnly);
  const dailyStartTime = epochToTimeHM(newStartEpoch);
  const visitDurSec = visitDurationSecondsFromEngagement(
    {
      ...oldEng,
      start_epoch: newStartEpoch,
      start_date: newStartDate,
    },
    {
      startTime: dailyStartTime,
      endTime: end_time || null,
    }
  );

  if (newProviderId) {
    const prospectiveEng = {
      ...oldEng,
      start_epoch: newStartEpoch,
      end_epoch: newEndEpoch,
      start_date: newStartDate,
      end_date: newEndDate,
      duration_minutes: Math.round(visitDurSec / 60),
    };
    const conflictRow = await findProviderBookedConflict(
      client,
      newProviderId,
      prospectiveEng,
      engagementId
    );
    if (conflictRow) {
      const err = new Error("Time overlap with another engagement for the provider");
      err.statusCode = 409;
      err.conflict = { engagement_id: conflictRow.engagement_id };
      throw err;
    }
  }

  if (providerBefore) {
    await client.query(
      `UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1`,
      [engagementId]
    );
  }

  if (newProviderId) {
    for (const day of dateList) {
      const ds = toEpochSeconds(day, dailyStartTime);
      const de = ds + visitDurSec;
      const exists = await client.query(
        `SELECT 1 FROM provider_availability WHERE engagement_id=$1 AND date=$2::date LIMIT 1`,
        [engagementId, day]
      );
      if (exists.rows.length > 0) {
        await client.query(
          `UPDATE provider_availability
           SET serviceproviderid=$1, slot_start_epoch=$2, slot_end_epoch=$3, status='BOOKED', updated_at=NOW()
           WHERE engagement_id=$4 AND date=$5::date`,
          [newProviderId, ds, de, engagementId, day]
        );
      } else {
        await client.query(
          `INSERT INTO provider_availability
            (serviceproviderid, engagement_id, date, slot_start_epoch, slot_end_epoch, status, created_at, updated_at)
           VALUES ($1,$2,$3::date,$4,$5,'BOOKED',NOW(),NOW())`,
          [newProviderId, engagementId, day, ds, de]
        );
      }
    }
  }

  if (setClauses.length > 0) {
    values.push(engagementId);
    await client.query(
      `UPDATE engagements SET ${setClauses.join(", ")} WHERE engagement_id=$${values.length}`,
      values
    );
  }

  const updateFields = [];
  const updateVals = [];
  let uIdx = 1;
  if (newStartEpoch !== oldEng.start_epoch) {
    updateFields.push(`start_epoch = $${uIdx++}`);
    updateVals.push(newStartEpoch);
  }
  if (newEndEpoch !== oldEng.end_epoch) {
    updateFields.push(`end_epoch = $${uIdx++}`);
    updateVals.push(newEndEpoch);
  }
  const oldStartYmd = normalizeYmdInput(oldEng.start_date);
  const oldEndYmd = normalizeYmdInput(oldEng.end_date);
  const newStartYmd = normalizeYmdInput(newStartDate);
  const newEndYmd = normalizeYmdInput(newEndDate);
  if (newStartYmd && newStartYmd !== oldStartYmd) {
    updateFields.push(`start_date = $${uIdx++}::date`);
    updateVals.push(newStartYmd);
  }
  if (newEndYmd && newEndYmd !== oldEndYmd) {
    updateFields.push(`end_date = $${uIdx++}::date`);
    updateVals.push(newEndYmd);
  }
  if (newProviderId !== providerBefore) {
    updateFields.push(`serviceproviderid = $${uIdx++}`);
    updateVals.push(newProviderId);
  }

  if (updateFields.length > 0) {
    updateVals.push(engagementId);
    await client.query(
      `UPDATE engagements SET ${updateFields.join(", ")} WHERE engagement_id=$${updateVals.length}`,
      updateVals
    );
  }

  const auditPayload = {
    modification_type: "SCHEDULE_MODIFIED",
    updated_fields: {
      start_date,
      end_date,
      start_time,
      end_time,
    },
    previous: {
      start_date: normalizeDateToIST(oldEng.start_date),
      end_date: normalizeDateToIST(oldEng.end_date),
      start_time: epochToTimeHM(oldEng.start_epoch),
      end_time: epochToTimeHM(oldEng.end_epoch),
    },
    updated: {
      start_date: normalizeDateToIST(newStartDate),
      end_date: normalizeDateToIST(newEndDate),
      start_time: epochToTimeHM(newStartEpoch),
      end_time: epochToTimeHM(newEndEpoch),
    },
  };

  await client.query(
    `INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at, modification_type)
     VALUES ($1,$2::jsonb,$3,$4,NOW(),$5)`,
    [
      engagementId,
      JSON.stringify(auditPayload),
      modified_by_id || null,
      modified_by_role || null,
      "SCHEDULE_MODIFIED",
    ]
  );

  const updated = (
    await client.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [engagementId])
  ).rows[0];
  updated.start_date = normalizeDateToIST(updated.start_date);
  updated.end_date = normalizeDateToIST(updated.end_date);
  updated.start_time = epochToTimeHM(updated.start_epoch);
  updated.end_time = epochToTimeHM(updated.end_epoch);
  return updated;
}

async function findScheduleModificationByOrder(client, razorpayOrderId) {
  // Use NOWAIT to prevent deadlock chains
  const res = await client.query(
    `SELECT modification_id, engagement_id, modified_fields, modification_type
     FROM engagement_modifications
     WHERE modified_fields->>'razorpay_order_id' = $1
       AND modification_type IN (
         'SCHEDULE_MODIFICATION_PENDING',
         'SCHEDULE_MODIFICATION_CANCELLED'
       )
     ORDER BY modified_at DESC
     LIMIT 1
     FOR UPDATE NOWAIT`,
    [razorpayOrderId]
  ).catch(err => {
    if (err.code === '55P03') { // lock_not_available
      const error = new Error("Payment verification already in progress. Please wait a moment.");
      error.statusCode = 409;
      throw error;
    }
    throw err;
  });
  return res.rows[0] || null;
}

/**
 * Mark a paid modification payment SUCCESS and apply the pending schedule (idempotent).
 * Used by modify-schedule/verify and Razorpay webhooks.
 */
export async function completePaidScheduleModification(
  client,
  { engagementId, razorpay_order_id, razorpay_payment_id, payment = null }
) {
  const mod = await findScheduleModificationByOrder(client, razorpay_order_id);
  if (!mod) {
    const err = new Error("No pending schedule modification for this payment");
    err.statusCode = 404;
    throw err;
  }
  if (Number(mod.engagement_id) !== Number(engagementId)) {
    const err = new Error("Engagement mismatch for modification payment");
    err.statusCode = 400;
    throw err;
  }

  const fields = parseModifiedFields(mod.modified_fields);
  if (!payment) {
    // Use NOWAIT to prevent deadlock when multiple processes try to verify payment
    const paymentRes = await client.query(
      `SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE NOWAIT`,
      [fields.modification_payment_id]
    ).catch(err => {
      if (err.code === '55P03') { // lock_not_available
        const error = new Error("Payment is being processed. Please wait a moment.");
        error.statusCode = 409;
        throw error;
      }
      throw err;
    });
    
    if (!paymentRes.rows.length) {
      const err = new Error("Modification payment not found");
      err.statusCode = 404;
      throw err;
    }
    payment = paymentRes.rows[0];
  }

  const engRes = await client.query(
    `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE NOWAIT`,
    [engagementId]
  ).catch(err => {
    if (err.code === '55P03') { // lock_not_available
      const error = new Error("Booking is being modified. Please wait a moment.");
      error.statusCode = 409;
      throw error;
    }
    throw err;
  });
  
  const eng = engRes.rows[0];
  const schedulePayload = fields.schedule || {};

  if (scheduleAlreadyMatches(eng, schedulePayload)) {
    return { alreadyApplied: true, engagement: eng, payment_id: payment.payment_id };
  }

  const walletAmount = Number(payment.wallet_amount ?? 0);
  if (payment.status !== "SUCCESS") {
    if (walletAmount > 0 && !payment.wallet_deducted) {
      await deductWalletForPayment(client, {
        customerId: eng.customerid,
        engagementId,
        amount: walletAmount,
        description: `Modification platform charge (wallet) for booking #${engagementId}`,
      });
      await client.query(`UPDATE payments SET wallet_deducted = true WHERE payment_id = $1`, [
        payment.payment_id,
      ]);
    }
    await client.query(
      `UPDATE payments SET status='SUCCESS', transaction_id=$1, updated_at=NOW() WHERE payment_id=$2`,
      [razorpay_payment_id, payment.payment_id]
    );
  } else if (razorpay_payment_id && !payment.transaction_id) {
    await client.query(
      `UPDATE payments SET transaction_id=$1, updated_at=NOW() WHERE payment_id=$2`,
      [razorpay_payment_id, payment.payment_id]
    );
  }

  const updated = await applyEngagementScheduleUpdate(client, engagementId, schedulePayload);
  return { success: true, engagement: updated, payment_id: payment.payment_id };
}

export async function initiateScheduleModification(engagementId, body) {
  // Step 1: Cleanup abandoned attempts in a SEPARATE transaction to avoid deadlocks
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query("BEGIN");
    
    // Quick read to get customerId for cleanup (no lock needed)
    const custRes = await cleanupClient.query(
      `SELECT customerid FROM engagements WHERE engagement_id=$1`,
      [engagementId]
    );
    if (custRes.rows.length > 0) {
      await cleanupAbandonedScheduleModificationAttempts(
        cleanupClient,
        engagementId,
        custRes.rows[0].customerid
      );
    }
    
    await cleanupClient.query("COMMIT");
  } catch (cleanupErr) {
    await cleanupClient.query("ROLLBACK");
    console.error("Cleanup failed (non-fatal):", cleanupErr.message);
    // Don't throw - cleanup failure shouldn't block the main operation
  } finally {
    cleanupClient.release();
  }

  // Step 2: Main modification transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock engagement FIRST (consistent lock ordering prevents deadlocks)
    const engRes = await client.query(
      `SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE NOWAIT`,
      [engagementId]
    ).catch(err => {
      if (err.code === '55P03') { // lock_not_available
        const error = new Error("This booking is currently being modified. Please try again in a moment.");
        error.statusCode = 409;
        throw error;
      }
      throw err;
    });
    
    if (!engRes.rows.length) {
      const err = new Error("Engagement not found");
      err.statusCode = 404;
      throw err;
    }
    const engagement = engRes.rows[0];
    const bookingType = String(engagement.booking_type || "").toUpperCase();
    if (!["MONTHLY", "SHORT_TERM"].includes(bookingType)) {
      const err = new Error("Only monthly and short-term bookings can be rescheduled here");
      err.statusCode = 400;
      throw err;
    }

    const life = String(engagement.engagement_status || "").toUpperCase();
    const task = String(engagement.task_status || "").toUpperCase();
    if (life === "CANCELLED" || task === "CANCELLED") {
      const err = new Error("Cancelled bookings cannot be modified");
      err.statusCode = 400;
      throw err;
    }

    const paymentRow = await resolveOriginalBookingPayment(client, engagementId);
    if (!paymentRow) {
      const err = new Error("Original booking payment must be completed before modifying schedule");
      err.statusCode = 400;
      throw err;
    }

    const bookingBase = resolveBookingBaseAmount(engagement, paymentRow);
    const fee = computeModificationPlatformCharge(bookingBase);
    const useWallet = Boolean(body.use_wallet ?? body.useWallet);
    const walletBalance = await getCustomerWalletBalance(client, engagement.customerid);
    const { wallet_amount, razorpay_amount } = computeWalletApplication(
      walletBalance,
      fee.total_amount,
      useWallet
    );

    const schedulePayload = {
      start_date: body.start_date,
      end_date: body.end_date,
      start_time: body.start_time,
      end_time: body.end_time,
      modified_by_id: body.modified_by_id,
      modified_by_role: body.modified_by_role || "CUSTOMER",
    };

    if (fee.total_amount <= 0) {
      const updated = await applyEngagementScheduleUpdate(client, engagementId, schedulePayload);
      await client.query("COMMIT");
      return {
        applied: true,
        wallet_only: false,
        engagement: updated,
        fee,
      };
    }

    if (razorpay_amount <= 0) {
      const paymentInsert = await client.query(
        `INSERT INTO payments
          (engagement_id, base_amount, platform_fee, gst, total_amount, wallet_amount,
           payment_mode, status, razorpay_order_id, wallet_deducted, created_at)
         VALUES ($1, 0, $2, $3, $4, $5, 'wallet', 'SUCCESS', NULL, true, NOW())
         RETURNING payment_id`,
        [engagementId, fee.platform_fee, fee.gst, fee.total_amount, wallet_amount]
      );

      if (wallet_amount > 0) {
        await deductWalletForPayment(client, {
          customerId: engagement.customerid,
          engagementId,
          amount: wallet_amount,
          description: `Modification platform charge for booking #${engagementId}`,
        });
      }

      const updated = await applyEngagementScheduleUpdate(client, engagementId, schedulePayload);
      await client.query("COMMIT");
      return {
        applied: true,
        wallet_only: true,
        engagement: updated,
        fee,
        wallet_amount,
        modification_payment_id: paymentInsert.rows[0].payment_id,
      };
    }

    const amountPaise = Math.round(razorpay_amount * 100);
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `eng_mod_${engagementId}_${Date.now()}`,
      notes: {
        engagementId: String(engagementId),
        purpose: "SCHEDULE_MODIFICATION",
      },
    });
    const razorpay_order_id = razorpayOrder.id;

    const paymentInsert = await client.query(
      `INSERT INTO payments
        (engagement_id, base_amount, platform_fee, gst, total_amount, wallet_amount,
         payment_mode, status, razorpay_order_id, wallet_deducted, created_at)
       VALUES ($1, 0, $2, $3, $4, $5, 'razorpay', 'PENDING', $6, $7, NOW())
       RETURNING payment_id`,
      [
        engagementId,
        fee.platform_fee,
        fee.gst,
        fee.total_amount,
        wallet_amount,
        razorpay_order_id,
        wallet_amount > 0,
      ]
    );
    const paymentId = paymentInsert.rows[0].payment_id;

    const pendingAudit = {
      modification_type: "SCHEDULE_MODIFICATION_PENDING",
      schedule: schedulePayload,
      fee: {
        ...fee,
        wallet_amount,
        razorpay_amount,
      },
      modification_payment_id: paymentId,
      razorpay_order_id,
      payment_status: "PENDING",
    };

    await client.query(
      `INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at, modification_type)
       VALUES ($1,$2::jsonb,$3,$4,NOW(),$5)`,
      [
        engagementId,
        JSON.stringify(pendingAudit),
        body.modified_by_id || null,
        body.modified_by_role || "CUSTOMER",
        "SCHEDULE_MODIFICATION_PENDING",
      ]
    );

    if (wallet_amount > 0) {
      await deductWalletForPayment(client, {
        customerId: engagement.customerid,
        engagementId,
        amount: wallet_amount,
        description: `Modification platform charge (wallet) for booking #${engagementId}`,
      });
    }

    await client.query("COMMIT");

    return {
      applied: false,
      requires_payment: true,
      engagement_id: Number(engagementId),
      modification_payment_id: paymentId,
      razorpay_order_id,
      razorpay_key_id: getRazorpayKeyId(),
      amount: Math.round(razorpay_amount * 100),
      amount_inr: razorpay_amount,
      total_amount_inr: fee.total_amount,
      wallet_amount_inr: wallet_amount,
      currency: "INR",
      fee,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function verifyRazorpaySignature(orderId, paymentId, signature) {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  const body = `${orderId}|${paymentId}`;
  const expected = createHmac("sha256", getRazorpayKeySecret()).update(body).digest("hex");
  return expected === signature;
}

export async function verifyScheduleModificationPayment({
  engagementId,
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}) {
  if (
    !verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)
  ) {
    const err = new Error("Invalid payment signature");
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await completePaidScheduleModification(client, {
      engagementId,
      razorpay_order_id,
      razorpay_payment_id,
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
