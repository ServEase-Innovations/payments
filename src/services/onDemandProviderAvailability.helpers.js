export const ON_DEMAND_PROVIDER_RADIUS_KM = 5;

export const ON_DEMAND_NO_PROVIDERS_MESSAGE =
  "No service providers are currently available in your area. Please try again later or choose a different location.";

export function serviceTypeToRole(serviceType) {
  const s = String(serviceType || "")
    .trim()
    .toUpperCase();
  if (s === "MAID" || s === "CLEANING") return "MAID";
  if (s === "NANNY" || s === "CAREGIVER") return "NANNY";
  if (s === "COOK" || s === "MEAL" || s === "COOKING") return "COOK";
  return s || "COOK";
}

export function normalizeBookingCoordinates(latitude, longitude) {
  if (latitude == null || longitude == null || latitude === "" || longitude === "") {
    return null;
  }
  let lat = Number(latitude);
  let lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    [lat, lng] = [lng, lat];
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  if (lat === 0 && lng === 0) {
    return null;
  }
  return { lat, lng };
}

function parseTimeslotRanges(timeslot) {
  if (!timeslot || typeof timeslot !== "string") return [];
  return timeslot
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [start, end] = part.split("-").map((s) => s?.trim()?.slice(0, 5));
      if (!start || !end || start >= end) return null;
      return { start, end };
    })
    .filter(Boolean);
}

/** True when provider has no timeslot or the visit start (HH:mm) falls in a configured range. */
export function isWithinProviderTimeslot(timeslot, startTimeHm) {
  const ranges = parseTimeslotRanges(timeslot);
  if (!ranges.length) return true;
  const t = String(startTimeHm || "").trim().slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(t)) return true;
  return ranges.some((r) => t >= r.start && t < r.end);
}
