import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  serviceTypeToRole,
  normalizeBookingCoordinates,
  isWithinProviderTimeslot,
  ON_DEMAND_PROVIDER_RADIUS_KM,
  ON_DEMAND_NO_PROVIDERS_MESSAGE,
} from "../src/services/onDemandProviderAvailability.helpers.js";

describe("onDemandProviderAvailability helpers", () => {
  it("maps service types to provider roles", () => {
    assert.equal(serviceTypeToRole("maid"), "MAID");
    assert.equal(serviceTypeToRole("COOK"), "COOK");
    assert.equal(serviceTypeToRole("caregiver"), "NANNY");
  });

  it("rejects missing or zero coordinates", () => {
    assert.equal(normalizeBookingCoordinates(null, 77), null);
    assert.equal(normalizeBookingCoordinates(12.97, null), null);
    assert.equal(normalizeBookingCoordinates(0, 0), null);
  });

  it("accepts valid coordinates and swaps when lat/lng reversed", () => {
    const coords = normalizeBookingCoordinates(77.59, 12.97);
    assert.ok(coords);
    assert.ok(Math.abs(coords.lat - 77.59) < 0.01);
    assert.ok(Math.abs(coords.lng - 12.97) < 0.01);

    const swapped = normalizeBookingCoordinates(95, 12.97);
    assert.ok(swapped);
    assert.ok(Math.abs(swapped.lat - 12.97) < 0.01);
    assert.ok(Math.abs(swapped.lng - 95) < 0.01);
  });

  it("checks provider timeslot windows", () => {
    assert.equal(isWithinProviderTimeslot("08:00-20:00", "10:30"), true);
    assert.equal(isWithinProviderTimeslot("08:00-20:00", "21:00"), false);
    assert.equal(isWithinProviderTimeslot("", "21:00"), true);
  });

  it("exports 5 km radius and user-facing message", () => {
    assert.equal(ON_DEMAND_PROVIDER_RADIUS_KM, 5);
    assert.match(ON_DEMAND_NO_PROVIDERS_MESSAGE, /no service providers/i);
  });
});
