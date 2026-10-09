-- Photoreal walkthroughs (docs/photoreal.md): the phone uploads a scan's photos, a cloud GPU turns
-- them into Gaussian splats (.spz) in the walkthrough model's frame, and the viewer shows them as
-- a third look next to "photos on" and "photos off". Idempotent, like every migration here.

-- The splats of the tour's capture, once trained.
alter table public.tours add column if not exists splat_url text;

-- Buyers can be shown the photoreal look first.
alter table public.tours drop constraint if exists tours_appearance_check;
alter table public.tours
  add constraint tours_appearance_check check (appearance in ('studio', 'captured', 'photoreal'));

-- One training run: created when the phone starts uploading, updated by the GPU worker.
create table if not exists public.photoreal_jobs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  -- The tour the splats are for (a capture sent again replaces the tour, and the splats with it).
  tour_id uuid references public.tours (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'uploading' check (status in ('uploading', 'queued', 'running', 'done', 'failed')),
  -- What the worker is doing ('downloading', 'training', 'uploading') and how far along (0–1).
  stage text,
  progress real not null default 0,
  message text,
  files integer not null default 0,
  bytes bigint not null default 0,
  splat_url text,
  stats jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists photoreal_jobs_property_id_idx on public.photoreal_jobs (property_id, created_at desc);
create index if not exists photoreal_jobs_user_id_idx on public.photoreal_jobs (user_id);

-- Realtors read their own jobs; the phone and the worker go through the server's service role.
alter table public.photoreal_jobs enable row level security;

drop policy if exists "Owners read their photoreal jobs" on public.photoreal_jobs;
create policy "Owners read their photoreal jobs" on public.photoreal_jobs
  for select to authenticated
  using (user_id = auth.uid());

-- The photos wait here while the GPU trains on them (private; removed when the job is done).
insert into storage.buckets (id, name, public)
values ('photoreal', 'photoreal', false)
on conflict (id) do nothing;
