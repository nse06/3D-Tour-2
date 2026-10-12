-- Photoreal photos kept for training again, and more than one version of the splats from the same
-- photos (docs/photoreal.md). Idempotent, like every migration here.

-- The photos now stay in the photoreal bucket after training, so the listing can be trained again
-- (a better trainer, the AI-enhanced version) without a rescan. A job trained again uses the photos
-- another job uploaded: that job's id names their folder.
alter table public.photoreal_jobs add column if not exists inputs_job_id uuid references public.photoreal_jobs (id) on delete set null;

-- When the job's own photos were deleted (a newer upload for the listing, or the realtor deleted
-- them); null while they're kept.
alter table public.photoreal_jobs add column if not exists inputs_deleted_at timestamptz;

-- Other versions of the splats made from the same photos, by name:
-- {"ai": {"status": "running" | "done" | "failed", "progress", "splatUrl", "stats", "message"}}.
alter table public.photoreal_jobs add column if not exists variants jsonb;
