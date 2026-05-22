-- V2 payment flow uses engagement_status values not in the original CHECK constraint.
-- Safe to re-run: drops and recreates engagements_engagement_status_check.

ALTER TABLE public.engagements
  ADD COLUMN IF NOT EXISTS engagement_status character varying(30)
    COLLATE pg_catalog."default" DEFAULT 'CREATED'::character varying;

ALTER TABLE public.engagements
  DROP CONSTRAINT IF EXISTS engagements_engagement_status_check;

ALTER TABLE public.engagements
  ADD CONSTRAINT engagements_engagement_status_check
  CHECK (
    engagement_status IS NULL
    OR engagement_status::text = ANY (
      ARRAY[
        'CREATED'::text,
        'PAYMENT_PENDING'::text,
        'PAYMENT_FAILED'::text,
        'OPEN_FOR_ACCEPTANCE'::text,
        'ASSIGNED'::text,
        'IN_PROGRESS'::text,
        'COMPLETED'::text,
        'CANCELLED'::text,
        'EXPIRED'::text,
        'UNASSIGNED'::text
      ]
    )
  );
