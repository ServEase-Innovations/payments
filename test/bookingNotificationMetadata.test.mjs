import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichAutoCancelNotificationMetadata,
  parseNotificationMetadata,
} from "../src/services/bookingNotificationMetadata.js";

describe("bookingNotificationMetadata", () => {
  it("parses JSON string metadata", () => {
    const meta = parseNotificationMetadata('{"refund_amount_inr":499}');
    assert.equal(meta.refund_amount_inr, 499);
  });

  it("enriches sparse auto-cancel metadata from joined engagement columns", () => {
    const meta = enrichAutoCancelNotificationMetadata({
      type: "BOOKING_AUTO_CANCELLED_NO_PROVIDER",
      metadata: { refund_amount_inr: 520 },
      eng_service_type: "MAID",
      eng_booking_type: "ON_DEMAND",
      eng_start_epoch: 1_700_000_000,
      eng_duration_minutes: 60,
      eng_address: "12 MG Road, Bengaluru",
      eng_base_amount: 450,
      pay_total_amount: 520,
    });

    assert.equal(meta.service_type, "MAID");
    assert.equal(meta.booking_type, "ON_DEMAND");
    assert.equal(meta.address, "12 MG Road, Bengaluru");
    assert.equal(meta.duration_minutes, 60);
    assert.equal(meta.refund_amount_inr, 520);
    assert.ok(meta.start_time_label);
  });
});
