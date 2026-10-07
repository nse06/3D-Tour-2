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
| 6 | Polish (design, loading, mobile, README) | done |

## Notes
- Next.js 16 (App Router, Turbopack), React 19, Tailwind v4, React Three Fiber.
- `cacheComponents` is intentionally disabled; data pages use `dynamic = "force-dynamic"`.
- Public sample tour (no DB): `/tour/sample`. QA handle: `window.__atrium` (api, space, order).
- Regenerate the demo capture with `npm run generate:demo` (writes `public/demo/*.glb` + `src/lib/demo/*.manifest.json`).
- Data: local JSON store in `.data/` by default; Supabase (Postgres + RLS + Storage) when `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` are set. Migration: `supabase/migrations/` (validated locally against Postgres 16 with stubbed auth/storage schemas, RLS checked for owner/other-realtor/anon).
- Verified end-to-end (headless Chromium, prod build): create listing → sample capture or .glb upload (manifest auto-creates rooms) → publish → `/tour/1234-sheridan-road` loads for an anonymous buyer; manual room editor on a manifest-free model; mobile layout.
- Milestone 6: guided autoplay tour, arrival title cards, WebGL fallback, branded 404, portrait FOV, trimmed demo lights (16) for mobile, README + .env.example.

**All six milestones are complete.**

## iPhone capture (follow-up)

| Piece | Status |
|-------|--------|
| Web: pairing (QR/deep link), phone upload/complete API, captured-lighting mode, Supabase migration | done — e2e tested against a prod build |
| Vercel readiness: Supabase integration env names, `/setup` guidance, idempotent migrations | done |
| ScanCore (Swift): CaptureScan → .glb + manifest | done — 14 XCTests (Linux + macOS CI), checked on Apple's 11-room RoomPlan sample |
| Atrium Capture app (SwiftUI + RoomPlan) | done — builds in CI (unsigned .ipa artifact) |
| Simulator e2e in CI (pair → demo scan → send to mock server) | added |
| On-device test in a real apartment | waiting on the user (install via Sideloadly or TestFlight, see ios/README.md) |

Next ideas: photo-textured meshes from the uploaded keyframes, navmesh free roaming, analytics.
