-- The remastered model (docs/remaster.md): a cloud GPU rebuilds the painted model from the photos
-- kept on the server (skins trained on every photo, unseen spots filled in, and more), a look of
-- its own next to photos on/off and photoreal. Its jobs are separate from the photoreal ones; they
-- only borrow the photos a photoreal upload left. Idempotent, like every migration here.

-- The tour's remastered model, once made.
alter table public.tours add column if not exists remaster_url text;

-- Buyers can be shown the remastered model first.
alter table public.tours drop constraint if exists tours_appearance_check;
alter table public.tours
  add constraint tours_appearance_check check (appearance in ('studio', 'captured', 'photoreal', 'remastered'));

create table if not exists public.remaster_jobs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  -- The tour remastered (a capture sent again replaces the tour, and its remaster with it).
  tour_id uuid references public.tours (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The photoreal upload whose photos it works from (its id names their folder).
  inputs_job_id uuid references public.photoreal_jobs (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- What the worker is doing ('downloading', 'skins', 'fill', 'uploading') and how far along (0–1).
  stage text,
  progress real not null default 0,
  message text,
  model_url text,
  stats jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists remaster_jobs_property_id_idx on public.remaster_jobs (property_id, created_at desc);
create index if not exists remaster_jobs_user_id_idx on public.remaster_jobs (user_id);

-- Realtors read their own jobs; the worker goes through the server's service role.
alter table public.remaster_jobs enable row level security;

drop policy if exists "Owners read their remaster jobs" on public.remaster_jobs;
create policy "Owners read their remaster jobs" on public.remaster_jobs
  for select to authenticated
  using (user_id = auth.uid());
