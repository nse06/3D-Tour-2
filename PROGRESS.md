# Build progress

Tracks the MVP milestones so work can resume automatically after a pause.
Branch: `claude/3d-real-estate-tour-mvp-pxgyqw`

| # | Milestone | Status |
|---|-----------|--------|
| 1 | App setup + demo property (generated `.glb` + scan manifest) | done |
| 2 | Three.js 3D viewer | done |
| 3 | Room/floor navigation + camera waypoints + floor plan | done |
| 4 | Realtor dashboard + property creation + capture upload | done |
| 5 | Public shareable tour URLs (`/tour/[slug]`) + publish flow | done |
| 6 | Polish (design, loading, mobile, README) | in progress |

## Notes
- Next.js 16 (App Router, Turbopack), React 19, Tailwind v4, React Three Fiber.
- `cacheComponents` is intentionally disabled; data pages use `dynamic = "force-dynamic"`.
- Public sample tour (no DB): `/tour/sample`. QA handle: `window.__atrium` (api, space, order).
- Regenerate the demo capture with `npm run generate:demo` (writes `public/demo/*.glb` + `src/lib/demo/*.manifest.json`).
- Data: local JSON store in `.data/` by default; Supabase (Postgres + RLS + Storage) when `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` are set. Migration: `supabase/migrations/` (validated locally against Postgres 16 with stubbed auth/storage schemas, RLS checked for owner/other-realtor/anon).
- Verified end-to-end (headless Chromium, prod build): create listing → sample capture or .glb upload (manifest auto-creates rooms) → publish → `/tour/1234-sheridan-road` loads for an anonymous buyer; manual room editor on a manifest-free model; mobile layout.
