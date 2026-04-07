import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

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

function epochToTimeHM(epochSeconds) {
  if (!epochSeconds) return null;
  return dayjs.unix(Number(epochSeconds)).tz("Asia/Kolkata").format("HH:mm");
}

function enumerateDates(start, end) {
  const res = [];
  const cur = new Date(start);
  const endD = new Date(end);
  while (cur <= endD) {
    res.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return res;
}

function computeDailyRate(baseAmount, startDate, endDate) {
  const totalDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) + 1;
  return Number(baseAmount) / totalDays;
}

async function getCustomerWalletId(client, customerId) {
  const walletRes = await client.query(`SELECT wallet_id FROM customer_wallets WHERE customerid=$1`, [customerId]);
  if (walletRes.rows.length === 0) {
    const insertRes = await client.query(
      `INSERT INTO customer_wallets (customerid, balance) VALUES ($1,0) RETURNING wallet_id`,
      [customerId]
    );
    return insertRes.rows[0].wallet_id;
  }
  return walletRes.rows[0].wallet_id;
}

async function ensureProviderWallet(client, providerId) {
  if (!providerId) return null;
  const walletRes = await client.query(`SELECT * FROM provider_wallets WHERE serviceproviderid=$1`, [providerId]);
  if (walletRes.rows.length === 0) {
    await client.query(
      `INSERT INTO provider_wallets (serviceproviderid, balance, security_deposit_collected) VALUES ($1,0,0)`,
      [providerId]
    );
  }
}

/**
 * Apply or modify vacation on an engagement (same rules as PUT /api/engagements/:id vacation branch).
 * Caller must have started a transaction on `client`.
 */
export async function applyVacationForEngagement(client, {
  engagementId,
  customerId,
  vacationStartDate,
  vacationEndDate,
  leaveType = "VACATION",
  modifiedById = null,
  modifiedByRole = "CUSTOMER",
}) {
  const engRow = await client.query(`SELECT * FROM engagements WHERE engagement_id=$1 FOR UPDATE`, [engagementId]);
  if (engRow.rows.length === 0) {
    const err = new Error("Engagement not found");
    err.statusCode = 404;
    throw err;
  }
  const oldEng = engRow.rows[0];

  if (Number(oldEng.customerid) !== Number(customerId)) {
    const err = new Error("Engagement does not belong to this customer");
    err.statusCode = 403;
    throw err;
  }

  if (!["SHORT_TERM", "MONTHLY"].includes(oldEng.booking_type)) {
    const err = new Error("Vacation only applies to SHORT_TERM or MONTHLY bookings");
    err.statusCode = 400;
    throw err;
  }

  const providerBefore = oldEng.serviceproviderid;
  if (!providerBefore) {
    const err = new Error("Assigned provider is required to apply vacation");
    err.statusCode = 400;
    throw err;
  }

  const customerWalletId = await getCustomerWalletId(client, customerId);
  await ensureProviderWallet(client, providerBefore);

  const prevVacStart = oldEng.vacation_start_date ? new Date(oldEng.vacation_start_date) : null;
  const prevVacEnd = oldEng.vacation_end_date ? new Date(oldEng.vacation_end_date) : null;
  const prevDates = prevVacStart && prevVacEnd ? enumerateDates(prevVacStart, prevVacEnd) : [];

  const vacStart = new Date(vacationStartDate);
  const vacEnd = new Date(vacationEndDate);
  if (vacStart > vacEnd) {
    const err = new Error("vacation_start_date must be <= vacation_end_date");
    err.statusCode = 400;
    throw err;
  }

  const engStart = new Date(oldEng.start_date);
  const engEnd = new Date(oldEng.end_date);
  if (vacStart < engStart || vacEnd > engEnd) {
    const err = new Error("Vacation dates must fall within engagement start/end dates");
    err.statusCode = 400;
    throw err;
  }

  const newDates = enumerateDates(vacStart, vacEnd);
  const restoredDates = prevDates.filter((d) => !newDates.includes(d));
  const freedDates = newDates.filter((d) => !prevDates.includes(d));

  if (restoredDates.length > 0) {
    const checkStartTime = epochToTimeHM(oldEng.start_epoch);
    const checkEndTime = epochToTimeHM(oldEng.end_epoch);
    if (!checkStartTime || !checkEndTime) {
      const err = new Error("Missing start/end time for overlap checks");
      err.statusCode = 400;
      throw err;
    }

    await client.query(`SELECT 1 FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) FOR UPDATE`, [
      providerBefore,
      restoredDates,
    ]);

    const availConflicts = await client.query(
      `SELECT date, engagement_id FROM provider_availability WHERE serviceproviderid=$1 AND date = ANY($2) AND engagement_id != $3 AND status='BOOKED'`,
      [providerBefore, restoredDates, engagementId]
    );
    if (availConflicts.rows.length > 0) {
      const err = new Error("Provider is already booked on some restored dates");
      err.statusCode = 409;
      err.conflicts = availConflicts.rows;
      throw err;
    }

    for (const day of restoredDates) {
      const dayStartEpoch = toEpochSeconds(day, checkStartTime);
      const dayEndEpoch = toEpochSeconds(day, checkEndTime);
      if (!dayStartEpoch || !dayEndEpoch || dayStartEpoch >= dayEndEpoch) {
        const err = new Error(`Invalid computed time range for date ${day}`);
        err.statusCode = 400;
        throw err;
      }

      const timeConflict = await client.query(
        `SELECT engagement_id, date FROM provider_availability WHERE serviceproviderid=$1 AND date=$2::date AND engagement_id != $3 AND $4 < slot_end_epoch AND $5 > slot_start_epoch LIMIT 1`,
        [providerBefore, day, engagementId, dayStartEpoch, dayEndEpoch]
      );
      if (timeConflict.rows.length > 0) {
        const err = new Error("Time overlap with other engagements on restored dates");
        err.statusCode = 409;
        err.conflict = timeConflict.rows[0];
        throw err;
      }
    }
  }

  const dailyRate = computeDailyRate(oldEng.base_amount, oldEng.start_date, oldEng.end_date);
  const prevLeaveDays = oldEng.leave_days || prevDates.length || 0;
  const newLeaveDays = newDates.length;
  const refundAmount = Number((newLeaveDays * dailyRate).toFixed(2));
  const penalty = prevLeaveDays > 0 ? 400 : 0;

  if (penalty > 0) {
    await client.query(`UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`, [penalty, customerWalletId]);
    const penBal = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [customerWalletId]);
    await client.query(
      `INSERT INTO wallet_transaction (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
       VALUES ($1,$2,$3,$4,'DEBIT',$5,$6)`,
      [
        customerWalletId,
        customerId,
        engagementId,
        penalty,
        "Vacation modification penalty",
        penBal.rows[0].balance,
      ]
    );
  }

  await client.query(`UPDATE customer_wallets SET balance = balance + $1 WHERE wallet_id=$2`, [refundAmount, customerWalletId]);
  const credBal = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [customerWalletId]);
  await client.query(
    `INSERT INTO wallet_transaction (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
     VALUES ($1,$2,$3,$4,'CREDIT',$5,$6)`,
    [
      customerWalletId,
      customerId,
      engagementId,
      refundAmount,
      `Vacation refund for ${newLeaveDays} day(s)`,
      credBal.rows[0].balance,
    ]
  );

  await client.query(`UPDATE provider_wallets SET balance = balance - $1 WHERE serviceproviderid=$2`, [refundAmount, providerBefore]);
  await client.query(`UPDATE payouts SET net_amount = net_amount - $1 WHERE engagement_id=$2`, [refundAmount, engagementId]);

  if (restoredDates.length > 0) {
    const repStartTime = epochToTimeHM(oldEng.start_epoch);
    const repEndTime = epochToTimeHM(oldEng.end_epoch);
    for (const day of restoredDates) {
      const ds = toEpochSeconds(day, repStartTime);
      const de = toEpochSeconds(day, repEndTime);
      await client.query(
        `UPDATE provider_availability SET status='BOOKED', slot_start_epoch=$1, slot_end_epoch=$2 WHERE engagement_id=$3 AND date=$4::date`,
        [ds, de, engagementId, day]
      );
    }
  }
  if (freedDates.length > 0) {
    for (const day of freedDates) {
      await client.query(
        `UPDATE provider_availability SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL WHERE engagement_id=$1 AND date=$2::date`,
        [engagementId, day]
      );
    }
  }

  await client.query(
    `UPDATE engagements SET vacation_start_date=$1::date, vacation_end_date=$2::date, leave_days=$3 WHERE engagement_id=$4`,
    [vacationStartDate, vacationEndDate, newLeaveDays, engagementId]
  );

  const auditEntry = {
    modification_type: prevDates.length === 0 ? "VACATION_ADDED" : "VACATION_MODIFIED",
    previous:
      prevDates.length > 0
        ? {
            vacation_start_date: prevVacStart ? prevVacStart.toISOString().slice(0, 10) : null,
            vacation_end_date: prevVacEnd ? prevVacEnd.toISOString().slice(0, 10) : null,
            leave_days: prevDates.length,
          }
        : null,
    updated: {
      vacation_start_date: vacationStartDate,
      vacation_end_date: vacationEndDate,
      leave_days: newLeaveDays,
      refund: refundAmount,
      leave_type: leaveType,
    },
    difference: {
      days_added: Math.max(0, newLeaveDays - prevLeaveDays),
      days_removed: Math.max(0, prevLeaveDays - newLeaveDays),
      penalty,
    },
    wallet_effect: {
      customer_credit: refundAmount,
      customer_debit: penalty,
      provider_debit: refundAmount,
      payout_adjustment: -refundAmount,
    },
    availability_changes: { dates_freed: freedDates, dates_rebooked: restoredDates },
  };

  await client.query(
    `INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
     VALUES ($1,$2::jsonb,$3,$4,NOW())`,
    [engagementId, JSON.stringify(auditEntry), modifiedById, modifiedByRole]
  );

  await client.query(
    `INSERT INTO customer_leaves
      (customerid, engagement_id, leave_start_date, leave_end_date, leave_type, total_days, refund_amount, status)
     VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,'APPROVED')`,
    [customerId, engagementId, vacationStartDate, vacationEndDate, leaveType, newLeaveDays, refundAmount]
  );

  const updatedEng = (await client.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [engagementId])).rows[0];

  return {
    engagement: updatedEng,
    audit: auditEntry,
    refund_amount: refundAmount,
    penalty,
    wallet_balance: credBal.rows[0].balance,
  };
}
