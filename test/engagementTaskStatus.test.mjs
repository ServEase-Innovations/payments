import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveTaskStatusForCustomer } from "../src/utils/engagementTaskStatus.js";

describe("deriveTaskStatusForCustomer — ON_DEMAND past bucket", () => {
  const onDemand = {
    booking_type: "ON_DEMAND",
    engagement_status: "IN_PROGRESS",
    task_status: "IN_PROGRESS",
  };

  it("does not mark a past visit as completed when service_day is still in progress", () => {
    const result = deriveTaskStatusForCustomer(onDemand, "past", {
      service_day_id: 7,
      status: "IN_PROGRESS",
    });

    assert.equal(result.task_status, "IN_PROGRESS");
    assert.match(result.work_summary.label, /not marked complete/i);
  });

  it("marks past ON_DEMAND as completed when service_day is completed", () => {
    const result = deriveTaskStatusForCustomer(onDemand, "past", {
      service_day_id: 7,
      status: "COMPLETED",
    });

    assert.equal(result.task_status, "COMPLETED");
  });

  it("marks past ON_DEMAND as completed when lifecycle is completed", () => {
    const result = deriveTaskStatusForCustomer(
      {
        ...onDemand,
        engagement_status: "COMPLETED",
        task_status: "COMPLETED",
      },
      "past",
      null
    );

    assert.equal(result.task_status, "COMPLETED");
  });
});
