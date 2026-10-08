-- Photo-textured iPhone scans also carry a clean model of the same rooms: the
-- viewer's "photos off" view (docs/iphone-capture.md §2.4). Idempotent.
alter table public.tours
  add column if not exists clean_asset_url text;
