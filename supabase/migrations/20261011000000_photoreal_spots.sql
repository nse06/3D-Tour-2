-- Where the photos behind a tour's photoreal splats were taken (docs/photoreal.md): the viewer shows
-- the splats near those spots and the painted model elsewhere. [[x, y, z, yaw, pitch], …] in the
-- model's frame. Idempotent, like every migration here.
alter table public.tours add column if not exists splat_spots jsonb;
