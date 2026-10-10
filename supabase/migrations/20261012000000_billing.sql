-- Billing (docs/billing.md): Stripe customers and subscriptions, and grants — what each listing is
-- paid for (published, made photoreal) and how. Realtors read their own rows; only the server's
-- service role writes them. Idempotent, like every migration here.

create table if not exists public.billing_customers (
  -- Stripe's customer id (cus_…).
  id text primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  -- Stripe's subscription id (sub_…).
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  customer_id text not null,
  plan text not null check (plan in ('unlimited', 'pro')),
  -- Stripe's status: active, trialing, past_due, canceled, unpaid, …
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists billing_subscriptions_user_id_idx on public.billing_subscriptions (user_id);

create table if not exists public.billing_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Kept when the listing is deleted: a free first listing or a month's Pro photoreal stays used.
  property_id uuid references public.properties (id) on delete set null,
  kind text not null check (kind in ('listing', 'photoreal')),
  source text not null check (source in ('purchase', 'subscription', 'free', 'pro_quota', 'exempt', 'beta', 'unbilled')),
  -- The Checkout Session (cs_…) for a purchase, otherwise '<kind>:<listing>' or 'free:<user>':
  -- the same grant is never recorded twice.
  reference text not null unique,
  amount_cents integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists billing_grants_user_id_idx on public.billing_grants (user_id, kind, created_at desc);
create index if not exists billing_grants_property_id_idx on public.billing_grants (property_id, kind);

-- One row once the server has started charging (it's created on the first billing request).
create table if not exists public.billing_settings (
  id integer primary key check (id = 1),
  started_at timestamptz not null default now()
);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_grants enable row level security;
alter table public.billing_settings enable row level security;

drop policy if exists "Owners read their billing customer" on public.billing_customers;
create policy "Owners read their billing customer" on public.billing_customers
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Owners read their subscriptions" on public.billing_subscriptions;
create policy "Owners read their subscriptions" on public.billing_subscriptions
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Owners read their grants" on public.billing_grants;
create policy "Owners read their grants" on public.billing_grants
  for select to authenticated
  using (user_id = auth.uid());

-- Once charging starts, listings already live keep their link (and can be republished free), and
-- a realtor's own session can't publish a listing nobody paid for: publishing goes through the
-- dashboard, which records the grant first.
create or replace function public.billing_start() returns void
language sql security definer set search_path = public as $$
  insert into public.billing_settings (id) values (1) on conflict (id) do nothing;
  insert into public.billing_grants (user_id, property_id, kind, source, reference)
    select p.user_id, p.id, 'listing', 'unbilled', 'listing:' || p.id
    from public.properties p
    where p.published
      and not exists (select 1 from public.billing_grants g where g.property_id = p.id and g.kind = 'listing')
  on conflict (reference) do nothing;
$$;

revoke execute on function public.billing_start() from public, anon, authenticated;
grant execute on function public.billing_start() to service_role;

create or replace function public.guard_publish() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not new.published then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.published then
      return new;
    end if;
  end if;
  -- The server (service role) and direct connections decide for themselves.
  if coalesce(auth.jwt() ->> 'role', '') not in ('anon', 'authenticated') then
    return new;
  end if;
  if exists (select 1 from public.billing_settings)
     and not exists (select 1 from public.billing_grants g where g.property_id = new.id and g.kind = 'listing') then
    raise exception 'This listing isn''t paid for yet. Publish it from the Atrium dashboard.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists properties_guard_publish on public.properties;
create trigger properties_guard_publish
  before insert or update of published on public.properties
  for each row execute function public.guard_publish();
