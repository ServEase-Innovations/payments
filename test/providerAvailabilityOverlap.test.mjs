import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeEngagementStatusSql,
  completedServiceDayConflictExclusionSql,
  TERMINAL_ENGAGEMENT_STATUSES,
  visitWindowFromEngagement,
} from "../src/services/providerAvailabilityOverlap.js";

test("TERMINAL_ENGAGEMENT_STATUSES includes COMPLETED and CANCELLED", () => {
  assert.ok(TERMINAL_ENGAGEMENT_STATUSES.includes("COMPLETED"));
  assert.ok(TERMINAL_ENGAGEMENT_STATUSES.includes("CANCELLED"));
});

test("activeEngagementStatusSql excludes terminal engagement rows", () => {
  const sql = activeEngagementStatusSql("e");
  assert.match(sql, /NOT IN/);
  for (const status of TERMINAL_ENGAGEMENT_STATUSES) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
  assert.match(sql, /task_status/i);
  assert.match(sql, /'COMPLETED'/);
});

test("completedServiceDayConflictExclusionSql ignores finished visit days", () => {
  const sql = completedServiceDayConflictExclusionSql("pa", "e");
  assert.match(sql, /service_days sd_done/);
  assert.match(sql, /sd_done\.service_date = pa\.date/);
  assert.match(sql, /'COMPLETED'/);
});

test("visitWindowFromEngagement clips ON_DEMAND to single calendar day", () => {
  const window = visitWindowFromEngagement({
    booking_type: "ON_DEMAND",
    start_epoch: 1_700_000_000,
    duration_minutes: 120,
    start_date: "2024-11-14",
  });
  assert.ok(window);
  assert.equal(window.isOnDemand, true);
  assert.equal(window.startDate, window.endDate);
  assert.equal(window.endEpoch, window.startEpoch + 120 * 60);
});
