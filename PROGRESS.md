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
| On-device test in a real apartment | done by the user: 4 rooms, 72 m² — sending failed (build 1, fixed in build 2), rooms overlapped (fixed in build 3) |
| Rooms in one frame (build 3): RoomPlan restarts every room at the phone's position; `RoomAlignment` places rooms on RoomPlan's merged structure, else along the walked path, with doorway checks | done — 10 XCTests; Apple's 11-room sample, rooms shifted into their own frames, comes back exactly; CI rebuilds it in the simulator |
| Rebuild saved scans without rescanning | done (build 3) — the user rebuilt their apartment: floor plans line up |
| Photos painted on the model (build 4): charts + atlases, two-pass baking with depth-tested best views, exposure matching, unlit model, captured look by default | done — the user's verdict: works and makes the space feel real, but soft; ghosting on appliances, stretched bed/armchair, bright band under the kitchen ceiling, white strips on wall edges |
| Sharper photo painting (build 5): one photo per ~3 cm cell with neighbour smoothing and seam-only blending, blur-aware scores, furniture in parts, face-only sampling, per-channel exposure/white-balance gains, seam leveling, wall-colored edges, walls extended to the ceiling, 8 mm texels; app takes full-resolution photos when the phone is steady and shows a photo count / slow-down hint | done — 10 photo XCTests + turn-rate test; waiting on the user's rebuild and a new slow scan |
| Photos on/off (build 6): photo scans also carry the clean styled model; buyers flip "Photos on/off" in the walkthrough, the realtor picks what buyers see first; the camera stays put; the DB column adds itself on first use | done — e2e in a browser (phone API → publish → buyer toggle → realtor default) |
| People painted out (build 7): Vision person segmentation per photo (upright thumbnail, mask turned back); masked photos don't count as seeing what's behind the person; spots every photo flags are painted only if seen ≥ 20° apart (posters) | done — 4 XCTests (a person in every photo: 68k texels → 0; a flagged poster still painted); works on rebuilds of existing scans |
| LiDAR shapes (build 7): RoomPlan runs on the app's own AR session with scene reconstruction; the mesh is saved per room; ScanCore crops it to the room, drops walls/floor/ceiling, welds, replaces the RoomPlan boxes it covers, cuts it into patches painted at their true surface points | done — 5 XCTests + a simulator rebuild with a mesh per room; needs a new scan on the phone to confirm RoomPlan keeps the session's mesh setting (info.json `lidarMesh`) |

## Photoreal prototype (`prototypes/photoreal`)

| Piece | Status |
|-------|--------|
| Synthetic apartment with ground truth: the demo scan rendered as a real home (real furniture shapes, clutter, two mirrors, a glossy floor, window views); 665 scan-like photos at 480 × 360 plus 12 held-out views | done |
| Painted models from those photos with the phone's own code (`scanproc paint`): today's boxes and build 7's LiDAR shapes | done |
| Gaussian splats on the CPU: C++ tile rasterizer with a hand-written backward pass (gradient-checked), PyTorch projection/SH/Adam, densify/prune/opacity resets, `.spz` export | done: 12,000 steps, 549k Gaussians, 2.7 h on 4 cores; the screen-size prune is now off (in rooms it deleted 45% of the splats and cost 3 dB) |
| Comparison page (published artifact): the same camera for all three, the real photo, 12 scored views, notes | done: PSNR today 20.70 / build 7 23.29 / splats 29.26 dB (SSIM 0.806 / 0.851 / 0.939); splats lead at all 12 views. three.js's splat viewer is patched to the trained kernel (its defaults cost 2.3 dB) |

Verdict so far: photoreal is far closer to the real rooms (window views, reflections, plants), at the cost of a cloud GPU step (15–30 min, ~$0.25–1 per listing), uploading the photos (100–400 MB; today they stay on the phone) and a 9 MB download. Suggested: ship build 7 now, add photoreal as a cloud upgrade.

Next: the user's rescan with build 7; their call on photoreal as a cloud upgrade; 360° photo spots at the waypoints; turn email confirmation back on before opening sign-ups.
