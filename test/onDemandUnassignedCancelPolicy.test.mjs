import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isEligibleForOnDemandAutoCancel,
  ON_DEMAND_AUTO_CANCEL_REASON,
  ON_DEMAND_AUTO_CANCEL_EVENT,
} from "../src/services/onDemandUnassignedCancelPolicy.js";

describe("onDemandUnassignedCancelPolicy", () => {
  const baseEngagement = {
    booking_type: "ON_DEMAND",
    serviceproviderid: null,
    assignment_status: "UNASSIGNED",
    engagement_status: "OPEN_FOR_ACCEPTANCE",
    task_status: "NOT_STARTED",
    start_epoch: 1_700_000_000,
  };

  const basePayment = {
    status: "SUCCESS",
  };

  it("exports audit reason and event type", () => {
    assert.match(ON_DEMAND_AUTO_CANCEL_REASON, /no provider available/i);
    assert.equal(ON_DEMAND_AUTO_CANCEL_EVENT, "ON_DEMAND_AUTO_CANCELLED_NO_PROVIDER");
  });

  it("eligible when start time passed and still unassigned", () => {
    assert.equal(
      isEligibleForOnDemandAutoCancel(
        baseEngagement,
        basePayment,
        baseEngagement.start_epoch
      ),
      true
    );
    assert.equal(
      isEligibleForOnDemandAutoCancel(
        baseEngagement,
        basePayment,
        baseEngagement.start_epoch + 3600
      ),
      true
    );
  });

  it("not eligible before start time", () => {
    assert.equal(
      isEligibleForOnDemandAutoCancel(
        baseEngagement,
        basePayment,
        baseEngagement.start_epoch - 60
      ),
      false
    );
  });

  it("not eligible when provider assigned or already cancelled", () => {
    assert.equal(
      isEligibleForOnDemandAutoCancel(
        { ...baseEngagement, serviceproviderid: 42 },
        basePayment,
        baseEngagement.start_epoch + 10
      ),
      false
    );
    assert.equal(
      isEligibleForOnDemandAutoCancel(
        { ...baseEngagement, task_status: "CANCELLED" },
        basePayment,
        baseEngagement.start_epoch + 10
      ),
      false
    );
    assert.equal(
      isEligibleForOnDemandAutoCancel(
        baseEngagement,
        { status: "REFUNDED" },
        baseEngagement.start_epoch + 10
      ),
      false
    );
  });
});
