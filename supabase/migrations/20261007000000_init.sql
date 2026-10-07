-- Atrium — 3D property tours
--
-- Spatial model:  properties → tours → floors → rooms (waypoints)
--
-- A tour is one 3D capture of a property: `asset_url` is the .glb the viewer
-- loads (uploaded, or built on the phone by the Atrium Capture app);
-- `scan_package_url` keeps an iPhone scan's raw data (RoomPlan rooms, ARKit
-- trajectory, RGB frames) for reprocessing; `processing_status` is reserved
-- for server-side processing.
--
-- Every statement is idempotent, so the concatenated migrations can be pasted
-- into the Supabase SQL editor again after an upgrade.

create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null default '',
  address_line text not null,
  city text not null default '',
  state text not null default '',
  postal_code text not null default '',
  price numeric(12, 0) not null default 0 check (price >= 0),
  bedrooms integer not null default 0 check (bedrooms >= 0),
  bathrooms numeric(4, 1) not null default 0 check (bathrooms >= 0),
  square_feet integer not null default 0 check (square_feet >= 0),
  description text not null default '',
  cover_image_url text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists properties_user_id_idx on public.properties (user_id);

create table if not exists public.tours (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  asset_url text not null,
  asset_format text not null default 'glb' check (asset_format in ('glb', 'gltf')),
  source text not null default 'upload' check (source in ('demo', 'upload', 'ios_scan')),
  scan_package_url text,
  processing_status text not null default 'ready' check (processing_status in ('ready', 'processing', 'failed')),
  -- { "links": [{ "from": room_id, "to": room_id, "via": [[x,y,z], ...], "kind": "door"|"stairs" }], "eyeHeight": 1.6 }
  navigation jsonb not null default '{"links": [], "eyeHeight": 1.6}'::jsonb,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists tours_property_id_idx on public.tours (property_id);

create table if not exists public.floors (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references public.tours (id) on delete cascade,
  name text not null,
  floor_number integer not null default 1,
  -- Walkable floor height in model units (meters).
  elevation real not null default 0,
  -- Plan polygons [[x, z], ...] — from RoomPlan in the future.
  outline jsonb,
  features jsonb not null default '[]'::jsonb
);

create index if not exists floors_tour_id_idx on public.floors (tour_id);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  floor_id uuid not null references public.floors (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  -- Camera waypoint: [x, y, z] and { "yaw": radians, "pitch": radians }.
  waypoint_position jsonb not null,
  waypoint_rotation jsonb not null default '{"yaw": 0, "pitch": 0}'::jsonb,
  footprint jsonb
);

create index if not exists rooms_floor_id_idx on public.rooms (floor_id);

-- ---------------------------------------------------------------------------
-- Row level security: realtors manage their own listings; anyone can read a
-- published tour (that's the shareable public URL).
-- ---------------------------------------------------------------------------

alter table public.properties enable row level security;
alter table public.tours enable row level security;
alter table public.floors enable row level security;
alter table public.rooms enable row level security;

drop policy if exists "Owners manage their properties" on public.properties;
create policy "Owners manage their properties" on public.properties
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Published properties are public" on public.properties;
create policy "Published properties are public" on public.properties
  for select to anon, authenticated
  using (published);

drop policy if exists "Owners manage their tours" on public.tours;
create policy "Owners manage their tours" on public.tours
  for all to authenticated
  using (exists (select 1 from public.properties p where p.id = property_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.properties p where p.id = property_id and p.user_id = auth.uid()));

drop policy if exists "Published tours are public" on public.tours;
create policy "Published tours are public" on public.tours
  for select to anon, authenticated
  using (published and exists (select 1 from public.properties p where p.id = property_id and p.published));

drop policy if exists "Owners manage their floors" on public.floors;
create policy "Owners manage their floors" on public.floors
  for all to authenticated
  using (exists (
    select 1 from public.tours t join public.properties p on p.id = t.property_id
    where t.id = tour_id and p.user_id = auth.uid()))
  with check (exists (
    select 1 from public.tours t join public.properties p on p.id = t.property_id
    where t.id = tour_id and p.user_id = auth.uid()));

drop policy if exists "Floors of published tours are public" on public.floors;
create policy "Floors of published tours are public" on public.floors
  for select to anon, authenticated
  using (exists (
    select 1 from public.tours t join public.properties p on p.id = t.property_id
    where t.id = tour_id and t.published and p.published));

drop policy if exists "Owners manage their rooms" on public.rooms;
create policy "Owners manage their rooms" on public.rooms
  for all to authenticated
  using (exists (
    select 1 from public.floors f join public.tours t on t.id = f.tour_id join public.properties p on p.id = t.property_id
    where f.id = floor_id and p.user_id = auth.uid()))
  with check (exists (
    select 1 from public.floors f join public.tours t on t.id = f.tour_id join public.properties p on p.id = t.property_id
    where f.id = floor_id and p.user_id = auth.uid()));

drop policy if exists "Rooms of published tours are public" on public.rooms;
create policy "Rooms of published tours are public" on public.rooms
  for select to anon, authenticated
  using (exists (
    select 1 from public.floors f join public.tours t on t.id = f.tour_id join public.properties p on p.id = t.property_id
    where f.id = floor_id and t.published and p.published));

-- Slugs are global (they form the public URL), but RLS hides other realtors'
-- drafts, so slug availability is checked by a security-definer helper.
create or replace function public.available_slug(base text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  candidate text := base;
  n integer := 2;
begin
  while exists (select 1 from public.properties where slug = candidate) loop
    candidate := base || '-' || n;
    n := n + 1;
  end loop;
  return candidate;
end;
$$;

revoke all on function public.available_slug(text) from public;
grant execute on function public.available_slug(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: 3D captures and cover photos. Public read (published tours load
-- assets anonymously); realtors write only inside their own folder
-- (<user_id>/<property_id>/...).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('captures', 'captures', true)
on conflict (id) do nothing;

drop policy if exists "Realtors upload into their folder" on storage.objects;
create policy "Realtors upload into their folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Realtors update their files" on storage.objects;
create policy "Realtors update their files" on storage.objects
  for update to authenticated
  using (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Realtors delete their files" on storage.objects;
create policy "Realtors delete their files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Captures are publicly readable" on storage.objects;
create policy "Captures are publicly readable" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'captures');
