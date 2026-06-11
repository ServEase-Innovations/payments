import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ON_DEMAND_CRM_ESCALATION_EVENT,
  ON_DEMAND_CUSTOMER_OUTREACH_EVENT,
  isEligibleForOnDemandCrmEscalation,
  isEligibleForOnDemandCustomerOutreach,
  isUnassignedOnDemandEngagement,
} from "../src/services/onDemandWorkflowPolicy.js";

describe("onDemandWorkflowPolicy", () => {
  const baseEngagement = {
    booking_type: "ON_DEMAND",
    serviceproviderid: null,
    assignment_status: "UNASSIGNED",
    engagement_status: "OPEN_FOR_ACCEPTANCE",
    task_status: "NOT_STARTED",
    start_epoch: 1_900_000_000,
  };

  const basePayment = { status: "SUCCESS" };
  const paidAt = new Date("2026-06-10T08:00:00.000Z");

  it("exports CRM workflow event types", () => {
    assert.equal(ON_DEMAND_CRM_ESCALATION_EVENT, "ON_DEMAND_CRM_ESCALATED");
    assert.equal(ON_DEMAND_CUSTOMER_OUTREACH_EVENT, "ON_DEMAND_CUSTOMER_OUTREACH");
  });

  it("detects unassigned on-demand engagements", () => {
    assert.equal(isUnassignedOnDemandEngagement(baseEngagement), true);
    assert.equal(
      isUnassignedOnDemandEngagement({
        ...baseEngagement,
        engagement_status: "CRM_ESCALATED",
      }),
      true
    );
    assert.equal(
      isUnassignedOnDemandEngagement({ ...baseEngagement, serviceproviderid: 7 }),
      false
    );
  });

  it("eligible for CRM escalation after acceptance window", () => {
    const nowEpoch = Math.floor(paidAt.getTime() / 1000) + 31 * 60;
    assert.equal(
      isEligibleForOnDemandCrmEscalation(
        baseEngagement,
        basePayment,
        paidAt,
        nowEpoch
      ),
      true
    );
  });

  it("not eligible for CRM escalation before acceptance window or start lead", () => {
    const nowEpoch = Math.floor(paidAt.getTime() / 1000) + 10 * 60;
    assert.equal(
      isEligibleForOnDemandCrmEscalation(
        { ...baseEngagement, start_epoch: nowEpoch + 3 * 60 * 60 },
        basePayment,
        paidAt,
        nowEpoch
      ),
      false
    );
  });

  it("eligible for CRM escalation 20 minutes before start even if acceptance window not elapsed", () => {
    const startEpoch = 1_900_000_000;
    const nowEpoch = startEpoch - 20 * 60;
    const recentPayment = new Date((nowEpoch - 10 * 60) * 1000);
    assert.equal(
      isEligibleForOnDemandCrmEscalation(
        { ...baseEngagement, start_epoch: startEpoch },
        basePayment,
        recentPayment,
        nowEpoch
      ),
      true
    );
  });

  it("eligible for customer outreach when CRM escalated and within lead window", () => {
    const startEpoch = 1_900_000_000;
    const nowEpoch = startEpoch - 60 * 60;
    assert.equal(
      isEligibleForOnDemandCustomerOutreach(
        { ...baseEngagement, engagement_status: "CRM_ESCALATED", start_epoch: startEpoch },
        basePayment,
        nowEpoch,
        { crmEscalated: true }
      ),
      true
    );
  });

  it("not eligible for customer outreach without CRM escalation", () => {
    const startEpoch = 1_900_000_000;
    const nowEpoch = startEpoch - 60 * 60;
    assert.equal(
      isEligibleForOnDemandCustomerOutreach(
        baseEngagement,
        basePayment,
        nowEpoch,
        { crmEscalated: false }
      ),
      false
    );
  });
});
