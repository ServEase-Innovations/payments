import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import {
  findProviderBookedConflictOnDates,
  releaseNonBlockingProviderAvailabilityOnDates,
} from "./providerAvailabilityOverlap.js";
import { sendVacationInAppNotifications } from "./vacationNotifications.service.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Kolkata");

/** Charged when customer changes an existing vacation window (not on first apply). */
export const VACATION_MODIFICATION_PENALTY = 400;

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

/** Calendar YYYY-MM-DD in Asia/Kolkata (matches PA rows and business dates; avoids `new Date('YYYY-MM-DD')` UTC drift). */
function toIstYmd(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return dayjs(value).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

function enumerateDates(start, end) {
  const startStr = toIstYmd(start);
  const endStr = toIstYmd(end);
  const res = [];
  let cur = dayjs.tz(startStr, "YYYY-MM-DD", "Asia/Kolkata").startOf("day");
  const endD = dayjs.tz(endStr, "YYYY-MM-DD", "Asia/Kolkata").startOf("day");
  while (!cur.isAfter(endD, "day")) {
    res.push(cur.format("YYYY-MM-DD"));
    cur = cur.add(1, "day");
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

/** Resolve restore conflicts after cleaning stale PA and checking real time overlap. */
async function findVacationRestoreConflict(client, providerId, engagement, dates, excludeEngagementId) {
  await releaseNonBlockingProviderAvailabilityOnDates(client, providerId, dates);
  return findProviderBookedConflictOnDates(
    client,
    providerId,
    engagement,
    dates,
    excludeEngagementId
  );
}

async function setEngagementDayAvailability(
  client,
  { serviceProviderId, engagementId, dayYmd, status, slotStartEpoch = null, slotEndEpoch = null }
) {
  await client.query(
    `UPDATE provider_availability
     SET status=$1, slot_start_epoch=$2, slot_end_epoch=$3, updated_at=NOW()
     WHERE engagement_id=$4 AND date=$5::date`,
    [status, slotStartEpoch, slotEndEpoch, engagementId, dayYmd]
  );

  const exists = await client.query(
    `SELECT 1 FROM provider_availability WHERE engagement_id=$1 AND date=$2::date LIMIT 1`,
    [engagementId, dayYmd]
  );
  if (exists.rows.length > 0) return;

  await client.query(
    `INSERT INTO provider_availability
      (serviceproviderid, engagement_id, date, status, slot_start_epoch, slot_end_epoch, created_at, updated_at)
     VALUES ($1,$2,$3::date,$4,$5,$6,NOW(),NOW())`,
    [serviceProviderId, engagementId, dayYmd, status, slotStartEpoch, slotEndEpoch]
  );
}

/** Restore every PA row in range to BOOKED for this engagement. */
async function restoreEngagementAvailabilityRange(
  client,
  { serviceProviderId, engagementId, startYmd, endYmd, startEpoch, endEpoch }
) {
  const repStartTime = epochToTimeHM(startEpoch);
  const repEndTime = epochToTimeHM(endEpoch);
  if (!repStartTime || !repEndTime) {
    const err = new Error("Missing start/end time to restore provider availability");
    err.statusCode = 400;
    throw err;
  }

  const dates = enumerateDates(startYmd, endYmd);
  for (const day of dates) {
    const ds = toEpochSeconds(day, repStartTime);
    const de = toEpochSeconds(day, repEndTime);
    await setEngagementDayAvailability(client, {
      serviceProviderId,
      engagementId,
      dayYmd: day,
      status: "BOOKED",
      slotStartEpoch: ds,
      slotEndEpoch: de,
    });
  }
  return dates;
}

async function reverseVacationWalletRefund(
  client,
  {
    customerWalletId,
    customerId,
    engagementId,
    providerId,
    refundAmount,
    description = "Vacation refund reversal",
  }
) {
  const amount = Number(Number(refundAmount).toFixed(2));
  if (amount <= 0) return null;

  await client.query(`UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`, [
    amount,
    customerWalletId,
  ]);
  const debBal = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [
    customerWalletId,
  ]);
  await client.query(
    `INSERT INTO wallet_transaction (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
     VALUES ($1,$2,$3,$4,'DEBIT',$5,$6)`,
    [customerWalletId, customerId, engagementId, amount, description, debBal.rows[0].balance]
  );

  await client.query(`UPDATE provider_wallets SET balance = balance + $1 WHERE serviceproviderid=$2`, [
    amount,
    providerId,
  ]);
  await client.query(`UPDATE payouts SET net_amount = net_amount + $1 WHERE engagement_id=$2`, [
    amount,
    engagementId,
  ]);

  return debBal.rows[0].balance;
}

async function creditVacationWalletRefund(
  client,
  {
    customerWalletId,
    customerId,
    engagementId,
    providerId,
    refundAmount,
    leaveDays,
    description,
  }
) {
  const amount = Number(Number(refundAmount).toFixed(2));
  if (amount <= 0) return null;

  await client.query(`UPDATE customer_wallets SET balance = balance + $1 WHERE wallet_id=$2`, [
    amount,
    customerWalletId,
  ]);
  const credBal = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [
    customerWalletId,
  ]);
  await client.query(
    `INSERT INTO wallet_transaction (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
     VALUES ($1,$2,$3,$4,'CREDIT',$5,$6)`,
    [
      customerWalletId,
      customerId,
      engagementId,
      amount,
      description || `Vacation refund for ${leaveDays} day(s)`,
      credBal.rows[0].balance,
    ]
  );

  await client.query(`UPDATE provider_wallets SET balance = balance - $1 WHERE serviceproviderid=$2`, [
    amount,
    providerId,
  ]);
  await client.query(`UPDATE payouts SET net_amount = net_amount - $1 WHERE engagement_id=$2`, [
    amount,
    engagementId,
  ]);

  return credBal.rows[0].balance;
}

async function assertWalletBalance(client, walletId, requiredAmount, message) {
  const required = Number(Number(requiredAmount).toFixed(2));
  if (required <= 0) return;

  const balRes = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [
    walletId,
  ]);
  const balance = Number(balRes.rows[0]?.balance ?? 0);
  if (balance < required) {
    const err = new Error(
      message ||
        `Insufficient wallet balance. ₹${required.toFixed(2)} required (available ₹${balance.toFixed(2)}).`
    );
    err.statusCode = 400;
    throw err;
  }
}

async function chargeVacationModificationPenalty(
  client,
  { customerWalletId, customerId, engagementId, penalty = VACATION_MODIFICATION_PENALTY }
) {
  const amount = Number(penalty);
  if (amount <= 0) return null;

  await client.query(`UPDATE customer_wallets SET balance = balance - $1 WHERE wallet_id=$2`, [
    amount,
    customerWalletId,
  ]);
  const penBal = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [
    customerWalletId,
  ]);
  await client.query(
    `INSERT INTO wallet_transaction (wallet_id, customerid, engagement_id, amount, transaction_type, description, balance_after)
     VALUES ($1,$2,$3,$4,'DEBIT',$5,$6)`,
    [
      customerWalletId,
      customerId,
      engagementId,
      amount,
      "Vacation modification penalty",
      penBal.rows[0].balance,
    ]
  );
  return penBal.rows[0].balance;
}

/** Mark PA rows as vacation-priority (SP reserved, eligible for on-demand) instead of FREE. */
async function markVacationPriorityAvailabilityRange(
  client,
  { serviceProviderId, engagementId, startYmd, endYmd, startEpoch, endEpoch }
) {
  const repStartTime = epochToTimeHM(startEpoch);
  const repEndTime = epochToTimeHM(endEpoch);
  if (!repStartTime || !repEndTime) {
    const err = new Error("Missing start/end time to mark vacation-priority availability");
    err.statusCode = 400;
    throw err;
  }

  const dates = enumerateDates(startYmd, endYmd);
  for (const day of dates) {
    const ds = toEpochSeconds(day, repStartTime);
    const de = toEpochSeconds(day, repEndTime);
    await setEngagementDayAvailability(client, {
      serviceProviderId,
      engagementId,
      dayYmd: day,
      status: "VACATION_PRIORITY",
      slotStartEpoch: ds,
      slotEndEpoch: de,
    });
  }
  return dates;
}

/** @deprecated Use markVacationPriorityAvailabilityRange — kept for reference in audits. */
async function freeEngagementAvailabilityRange(client, engagementId, startYmd, endYmd) {
  await client.query(
    `UPDATE provider_availability
     SET status='FREE', slot_start_epoch=NULL, slot_end_epoch=NULL, updated_at=NOW()
     WHERE engagement_id=$1
       AND date >= $2::date
       AND date <= $3::date`,
    [engagementId, startYmd, endYmd]
  );
}

async function notifyVacationChange(result, overrides = {}) {
  const audit = result?.audit || {};
  try {
    await sendVacationInAppNotifications({
      engagement: result.engagement,
      modificationType: overrides.modificationType || audit.modification_type,
      vacationStartDate:
        overrides.vacationStartDate ??
        audit.updated?.vacation_start_date ??
        audit.previous?.vacation_start_date,
      vacationEndDate:
        overrides.vacationEndDate ??
        audit.updated?.vacation_end_date ??
        audit.previous?.vacation_end_date,
      leaveDays:
        overrides.leaveDays ?? audit.updated?.leave_days ?? audit.previous?.leave_days,
      refundAmount: overrides.refundAmount ?? result.refund_amount,
      penalty: overrides.penalty ?? result.penalty,
      refundReversed: overrides.refundReversed ?? result.refund_reversed,
    });
  } catch (err) {
    console.error("vacation in-app notification failed:", err);
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

  const prevVacStartYmd = oldEng.vacation_start_date ? toIstYmd(oldEng.vacation_start_date) : null;
  const prevVacEndYmd = oldEng.vacation_end_date ? toIstYmd(oldEng.vacation_end_date) : null;
  const prevDates =
    prevVacStartYmd && prevVacEndYmd ? enumerateDates(prevVacStartYmd, prevVacEndYmd) : [];

  const vacStartYmd = toIstYmd(vacationStartDate);
  const vacEndYmd = toIstYmd(vacationEndDate);
  if (vacStartYmd > vacEndYmd) {
    const err = new Error("vacation_start_date must be <= vacation_end_date");
    err.statusCode = 400;
    throw err;
  }

  const engStartYmd = toIstYmd(oldEng.start_date);
  const engEndYmd = toIstYmd(oldEng.end_date);
  if (vacStartYmd < engStartYmd || vacEndYmd > engEndYmd) {
    const err = new Error("Vacation dates must fall within engagement start/end dates");
    err.statusCode = 400;
    throw err;
  }

  const newDates = enumerateDates(vacStartYmd, vacEndYmd);
  const isReplace = prevDates.length > 0;
  const datesLeavingVacation = isReplace ? prevDates.filter((d) => !newDates.includes(d)) : [];

  if (datesLeavingVacation.length > 0) {
    const conflict = await findVacationRestoreConflict(
      client,
      providerBefore,
      oldEng,
      datesLeavingVacation,
      engagementId
    );
    if (conflict) {
      const err = new Error("Provider is already booked on some restored dates");
      err.statusCode = 409;
      err.conflicts = [conflict];
      err.conflict = conflict;
      throw err;
    }
  }

  const dailyRate = computeDailyRate(oldEng.base_amount, oldEng.start_date, oldEng.end_date);
  const prevLeaveDays = oldEng.leave_days || prevDates.length || 0;
  const newLeaveDays = newDates.length;
  const prevRefundAmount = Number((prevLeaveDays * dailyRate).toFixed(2));
  const refundAmount = Number((newLeaveDays * dailyRate).toFixed(2));
  const vacationDatesChanged =
    !isReplace || prevVacStartYmd !== vacStartYmd || prevVacEndYmd !== vacEndYmd;
  const penalty = isReplace && vacationDatesChanged ? VACATION_MODIFICATION_PENALTY : 0;
  let walletBalance = null;

  if (isReplace) {
    const requiredDebit = Number((prevRefundAmount + penalty).toFixed(2));
    if (requiredDebit > 0) {
      await assertWalletBalance(
        client,
        customerWalletId,
        requiredDebit,
        `Insufficient wallet balance to update vacation. ₹${prevRefundAmount.toFixed(2)} prior refund reversal${
          penalty > 0 ? ` plus ₹${penalty} modification fee` : ""
        } must be covered before the new refund is credited.`
      );
    }
  }

  /* Replace flow: tear down previous vacation completely, then apply the new window. */
  if (isReplace) {
    await restoreEngagementAvailabilityRange(client, {
      serviceProviderId: providerBefore,
      engagementId,
      startYmd: prevVacStartYmd,
      endYmd: prevVacEndYmd,
      startEpoch: oldEng.start_epoch,
      endEpoch: oldEng.end_epoch,
    });

    if (prevRefundAmount > 0) {
      await reverseVacationWalletRefund(client, {
        customerWalletId,
        customerId,
        engagementId,
        providerId: providerBefore,
        refundAmount: prevRefundAmount,
        description: "Previous vacation refund reversed for update",
      });
    }

    await client.query(
      `UPDATE customer_leaves
       SET status='CANCELLED'
       WHERE engagement_id=$1 AND UPPER(COALESCE(status, '')) = 'APPROVED'`,
      [engagementId]
    );
  }

  if (penalty > 0) {
    walletBalance = await chargeVacationModificationPenalty(client, {
      customerWalletId,
      customerId,
      engagementId,
      penalty,
    });
  }

  if (refundAmount > 0) {
    walletBalance = await creditVacationWalletRefund(client, {
      customerWalletId,
      customerId,
      engagementId,
      providerId: providerBefore,
      refundAmount,
      leaveDays: newLeaveDays,
    });
  }

  if (walletBalance == null) {
    const bal = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [
      customerWalletId,
    ]);
    walletBalance = bal.rows[0]?.balance ?? 0;
  }

  await markVacationPriorityAvailabilityRange(client, {
    serviceProviderId: providerBefore,
    engagementId,
    startYmd: vacStartYmd,
    endYmd: vacEndYmd,
    startEpoch: oldEng.start_epoch,
    endEpoch: oldEng.end_epoch,
  });

  await client.query(
    `UPDATE engagements
     SET vacation_start_date=$1::date,
         vacation_end_date=$2::date,
         leave_days=$3,
         vacation_priority_provider_id=$4
     WHERE engagement_id=$5`,
    [vacationStartDate, vacationEndDate, newLeaveDays, providerBefore, engagementId]
  );

  const auditEntry = {
    modification_type: isReplace ? "VACATION_MODIFIED" : "VACATION_ADDED",
    previous:
      isReplace
        ? {
            vacation_start_date: prevVacStartYmd,
            vacation_end_date: prevVacEndYmd,
            leave_days: prevLeaveDays,
            refund_reversed: prevRefundAmount,
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
      modification_fee: penalty,
      vacation_dates_changed: vacationDatesChanged,
      refund_delta: Number((refundAmount - prevRefundAmount).toFixed(2)),
    },
    wallet_effect: {
      customer_credit: refundAmount,
      customer_debit: penalty + (isReplace ? prevRefundAmount : 0),
      provider_debit: refundAmount,
      provider_credit: isReplace ? prevRefundAmount : 0,
      payout_adjustment: Number((prevRefundAmount - refundAmount).toFixed(2)),
    },
    availability_changes: {
      previous_vacation_restored: isReplace ? prevDates : [],
      new_vacation_priority: newDates,
    },
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

  const result = {
    engagement: updatedEng,
    audit: auditEntry,
    refund_amount: refundAmount,
    penalty,
    wallet_balance: walletBalance,
    previous_refund_reversed: isReplace ? prevRefundAmount : 0,
  };

  return result;
}

/** Call after the DB transaction commits. */
export async function notifyVacationApplyResult(result) {
  await notifyVacationChange(result);
}

/**
 * Cancel vacation on an engagement: restore PA, reverse wallet refund, clear vacation columns.
 * Caller must have started a transaction on `client`.
 */
export async function cancelVacationForEngagement(client, {
  engagementId,
  customerId,
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

  const providerBefore = oldEng.serviceproviderid;
  if (!providerBefore) {
    const err = new Error("Assigned provider is required to cancel vacation");
    err.statusCode = 400;
    throw err;
  }

  const prevVacStartYmd = oldEng.vacation_start_date ? toIstYmd(oldEng.vacation_start_date) : null;
  const prevVacEndYmd = oldEng.vacation_end_date ? toIstYmd(oldEng.vacation_end_date) : null;
  const prevDates =
    prevVacStartYmd && prevVacEndYmd ? enumerateDates(prevVacStartYmd, prevVacEndYmd) : [];

  if (prevDates.length === 0) {
    const err = new Error("No existing vacation to cancel");
    err.statusCode = 400;
    throw err;
  }

  const customerWalletId = await getCustomerWalletId(client, customerId);
  await ensureProviderWallet(client, providerBefore);

  const holdProviderId =
    oldEng.vacation_priority_provider_id != null
      ? Number(oldEng.vacation_priority_provider_id)
      : Number(providerBefore);

  const conflict = await findVacationRestoreConflict(
    client,
    holdProviderId,
    oldEng,
    prevDates,
    engagementId
  );
  if (conflict) {
    const err = new Error(
      "Cannot cancel vacation; provider is booked on some previously-vacation dates"
    );
    err.statusCode = 409;
    err.conflicts = [conflict];
    err.conflict = conflict;
    throw err;
  }

  const dailyRate = computeDailyRate(oldEng.base_amount, oldEng.start_date, oldEng.end_date);
  const refundToRevert = Number(
    ((oldEng.leave_days || prevDates.length) * dailyRate).toFixed(2)
  );

  if (refundToRevert > 0) {
    await reverseVacationWalletRefund(client, {
      customerWalletId,
      customerId,
      engagementId,
      providerId: holdProviderId,
      refundAmount: refundToRevert,
      description: "Vacation cancellation refund reversal",
    });
  }

  if (Number(oldEng.serviceproviderid) !== holdProviderId) {
    await client.query(
      `UPDATE engagements SET serviceproviderid=$1 WHERE engagement_id=$2`,
      [holdProviderId, engagementId]
    );
    oldEng.serviceproviderid = holdProviderId;
  }

  await restoreEngagementAvailabilityRange(client, {
    serviceProviderId: holdProviderId,
    engagementId,
    startYmd: prevVacStartYmd,
    endYmd: prevVacEndYmd,
    startEpoch: oldEng.start_epoch,
    endEpoch: oldEng.end_epoch,
  });

  await client.query(
    `UPDATE engagements
     SET vacation_start_date=NULL,
         vacation_end_date=NULL,
         leave_days=0,
         vacation_priority_provider_id=NULL
     WHERE engagement_id=$1`,
    [engagementId]
  );

  await client.query(
    `UPDATE customer_leaves
     SET status='CANCELLED'
     WHERE engagement_id=$1 AND UPPER(COALESCE(status, '')) = 'APPROVED'`,
    [engagementId]
  );

  const auditEntry = {
    modification_type: "VACATION_CANCELLED",
    previous: {
      vacation_start_date: prevVacStartYmd,
      vacation_end_date: prevVacEndYmd,
      leave_days: prevDates.length,
    },
    updated: null,
    wallet_effect: {
      customer_debit: refundToRevert,
      provider_credit: refundToRevert,
      payout_adjustment: refundToRevert,
    },
    availability_changes: { dates_rebooked: prevDates },
    provider_restored: holdProviderId,
  };

  await client.query(
    `INSERT INTO engagement_modifications (engagement_id, modified_fields, modified_by_id, modified_by_role, modified_at)
     VALUES ($1,$2::jsonb,$3,$4,NOW())`,
    [engagementId, JSON.stringify(auditEntry), modifiedById, modifiedByRole]
  );

  const updatedEng = (await client.query(`SELECT * FROM engagements WHERE engagement_id=$1`, [engagementId]))
    .rows[0];

  const balRes = await client.query(`SELECT balance FROM customer_wallets WHERE wallet_id=$1`, [
    customerWalletId,
  ]);

  const result = {
    engagement: updatedEng,
    audit: auditEntry,
    refund_reversed: refundToRevert,
    wallet_balance: balRes.rows[0]?.balance ?? 0,
    restored_provider_id: holdProviderId,
  };

  return result;
}

/** Call after the DB transaction commits. */
export async function notifyVacationCancelResult(result) {
  await notifyVacationChange(result, { modificationType: "VACATION_CANCELLED" });
}
