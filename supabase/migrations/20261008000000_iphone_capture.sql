-- iPhone capture: the Atrium Capture app pairs with a listing and uploads its
-- scans (docs/iphone-capture.md §3). Idempotent, like every migration here.

-- How the viewer lights a capture: 'studio' (PBR materials under studio
-- light) or 'captured' (unlit — the textures already hold the real lighting).
alter table public.tours
  add column if not exists appearance text not null default 'studio';

alter table public.tours drop constraint if exists tours_appearance_check;
alter table public.tours
  add constraint tours_appearance_check check (appearance in ('studio', 'captured'));

-- A capture session pairs one phone with one listing. The phone holds a random
-- token (QR code / deep link); only its SHA-256 is stored. The phone's
-- endpoints look sessions up by token hash with the service-role key, so
-- realtors only ever see their own sessions.
create table if not exists public.capture_sessions (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- When the last scan arrived with this session.
  completed_at timestamptz
);

create index if not exists capture_sessions_property_id_idx on public.capture_sessions (property_id);
create index if not exists capture_sessions_user_id_idx on public.capture_sessions (user_id);

alter table public.capture_sessions enable row level security;

drop policy if exists "Owners manage their capture sessions" on public.capture_sessions;
create policy "Owners manage their capture sessions" on public.capture_sessions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.properties p where p.id = property_id and p.user_id = auth.uid()));
