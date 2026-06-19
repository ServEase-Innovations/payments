-- On-demand provider acceptance queue (max 5 per engagement; position 1 = primary).

CREATE TABLE IF NOT EXISTS public.engagement_provider_queue (
  queue_id bigserial PRIMARY KEY,
  engagement_id bigint NOT NULL REFERENCES public.engagements (engagement_id) ON DELETE CASCADE,
  serviceproviderid bigint NOT NULL REFERENCES public.serviceprovider (serviceproviderid) ON DELETE CASCADE,
  queue_position integer NOT NULL CHECK (queue_position >= 1 AND queue_position <= 5),
  status character varying(24) NOT NULL DEFAULT 'ACTIVE',
  accepted_at timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT engagement_provider_queue_engagement_provider_key UNIQUE (engagement_id, serviceproviderid)
);

CREATE UNIQUE INDEX IF NOT EXISTS engagement_provider_queue_active_position_idx
  ON public.engagement_provider_queue (engagement_id, queue_position)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS engagement_provider_queue_provider_active_idx
  ON public.engagement_provider_queue (serviceproviderid)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS public.engagement_provider_declines (
  engagement_id bigint NOT NULL REFERENCES public.engagements (engagement_id) ON DELETE CASCADE,
  serviceproviderid bigint NOT NULL REFERENCES public.serviceprovider (serviceproviderid) ON DELETE CASCADE,
  declined_at timestamp with time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (engagement_id, serviceproviderid)
);

INSERT INTO public.engagement_provider_queue
  (engagement_id, serviceproviderid, queue_position, status)
SELECT e.engagement_id, e.serviceproviderid, 1, 'ACTIVE'
FROM public.engagements e
WHERE UPPER(COALESCE(e.booking_type, '')) = 'ON_DEMAND'
  AND e.serviceproviderid IS NOT NULL
  AND UPPER(COALESCE(e.assignment_status, '')) = 'ASSIGNED'
  AND NOT EXISTS (
    SELECT 1 FROM public.engagement_provider_queue q
    WHERE q.engagement_id = e.engagement_id AND q.status = 'ACTIVE'
  );
