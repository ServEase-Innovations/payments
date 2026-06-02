# Epoch-First API Contract (Phase 1)

This document defines the time contract for bookings/calendar payloads in payments APIs.

## Canonical rule

- Epoch fields are the source of truth for sorting, bucketing, and comparisons.
- String date/time fields remain for backward compatibility in Phase 1.
- UI should render from epoch first, then fallback to legacy fields when epoch is missing.

## Field conventions

- `*_epoch`: Unix epoch seconds (integer), IST-aware semantics for day boundaries where relevant.
- `start_epoch` / `end_epoch`: visit/engagement instant boundaries.
- `date_epoch`: start of the `date` in Asia/Kolkata (00:00 IST).
- `start_date_epoch`: start of `start_date` in Asia/Kolkata.
- `end_date_epoch`: end of `end_date` in Asia/Kolkata.

## Current endpoint coverage

### Customer

- `GET /api/customers/:customerId/engagements`
  - Includes `start_epoch`, `end_epoch`.
- `GET /api/customers/:customerId/today-bookings`
  - Includes slot epochs and engagement epochs:
  - `slot_start_epoch`, `slot_end_epoch`
  - `engagement_start_epoch`, `engagement_end_epoch`

### Provider

- `GET /api/service-providers/:providerId/engagements`
  - Includes normalized:
  - `start_epoch`, `end_epoch`
  - `start_date_epoch`, `end_date_epoch`
- `GET /api/service-providers/:providerId/today-bookings`
  - Includes slot epochs and engagement epochs:
  - `slot_start_epoch`, `slot_end_epoch`
  - `engagement_start_epoch`, `engagement_end_epoch`
- `GET /api/service-providers/:providerId/calendar`
  - Includes:
  - `date_epoch`, `start_epoch`, `end_epoch`
- `GET /api/service-providers/:providerId/availability/blocks`
  - Includes:
  - `date_epoch`, `start_epoch`, `end_epoch`

## Compatibility policy (Phase 1)

- Keep existing fields:
  - `start_date`, `end_date`, `startTime`, `endTime`, `start_time`, `end_time`, `start_time_ist`, `end_time_ist`
- New clients must prefer epoch fields.
- Old clients continue functioning unchanged.

## Next phase (Phase 2)

- Remove mixed date/time interpretation from API consumers.
- Deprecate legacy string time fields after all clients adopt epoch fields.
- Keep display-only formatted fields optional and documented as non-canonical.

