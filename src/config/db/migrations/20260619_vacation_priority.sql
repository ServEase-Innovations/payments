-- Vacation priority: SP stays reserved (not FREE) during customer vacation;
-- on-demand bookings prioritize these providers; same SP restored on vacation cancel.

ALTER TABLE public.engagements
  ADD COLUMN IF NOT EXISTS vacation_priority_provider_id bigint;

COMMENT ON COLUMN public.engagements.vacation_priority_provider_id IS
  'Service provider reserved when customer applies vacation; restored on vacation cancel.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'engagements_vacation_priority_provider_fkey'
  ) THEN
    ALTER TABLE public.engagements
      ADD CONSTRAINT engagements_vacation_priority_provider_fkey
      FOREIGN KEY (vacation_priority_provider_id)
      REFERENCES public.serviceprovider (serviceproviderid)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill hold provider for active vacations
UPDATE public.engagements e
SET vacation_priority_provider_id = e.serviceproviderid
WHERE e.vacation_start_date IS NOT NULL
  AND e.vacation_end_date IS NOT NULL
  AND e.serviceproviderid IS NOT NULL
  AND e.vacation_priority_provider_id IS NULL;

-- Legacy FREE vacation rows → VACATION_PRIORITY (slots restored from engagement where missing)
UPDATE public.provider_availability pa
SET status = 'VACATION_PRIORITY',
    updated_at = NOW()
FROM public.engagements e
WHERE pa.engagement_id = e.engagement_id
  AND e.vacation_start_date IS NOT NULL
  AND e.vacation_end_date IS NOT NULL
  AND pa.date >= e.vacation_start_date::date
  AND pa.date <= e.vacation_end_date::date
  AND UPPER(TRIM(COALESCE(pa.status, ''))) = 'FREE';
