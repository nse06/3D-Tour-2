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
| Sharper painting (build 8): photos lined up with each other before painting (rigid color-map optimization on 320 px thumbnails, kept only where they agree better); 320 px millimeter depth images with a slope-aware hidden test; photos lose their say next to outlines; ~78° grazing limit; consensus vote against things in front of a surface; LiDAR shapes on a 2.5 cm grid with Taubin smoothing (150k triangles) | done — 3 new XCTests (pose gradient checked by finite differences; drifted photos 2.37 → ~1.0 px off; smoothing flattens bumps without shrinking); messy synthetic benchmark 21.22 → 22.00 dB (SSIM 0.776 → 0.796), clean 23.40 → 23.65; ~2× painting time |
| Viewer (build 8 data): photo scans no wider than the photos (85° across); opaque floor-plan panel; starting spots where photos were taken | done — 1 XCTest + web lint/typecheck/build |
| Coverage map while scanning (build 8): the room so far from above, heading up, walls/floor/furniture green (a good photo), amber (side-on or far), red (none yet) by the painting's own rules; "Done with this room" asks when under 60% of walls or 35% of floor is covered well; what furniture stands right in front of (the wall behind a wardrobe, a cabinet side against the next) needs no photo | done — 6 XCTests; checked on the synthetic apartment (a full pass: walls 95–97%, floor 89–91%); needs the phone to judge it live |
| Furniture polish (build 9): TVs as 6 cm panels in the middle of RoomPlan's box; furniture faces no photo saw take the color of the rest of their own piece | done — 2 XCTests |

## Photoreal walkthroughs (build 9, [docs/photoreal.md](docs/photoreal.md))

| Piece | Status |
|-------|--------|
| Phone export (`PhotorealExport.swift`): `cameras.json` (poses as painted, in the model's frame), `seeds.ply` (3 cm points on seen surfaces), people masks | done — 3 XCTests; checked on the synthetic apartment (seeds match their photos to a median 3.3 levels); CI checks a rebuilt scan's export |
| Phone upload: **Make it photoreal** after sending (four files at a time, three tries each, job status on the scan's page) | done — the app's upload code run on Linux against the site (667 files, 127 MB in 3.8 s) and the mock server; simulator CI step added |
| Site: `photoreal_jobs`, private `photoreal` bucket, phone routes, GPU dispatch, worker callback (shared secret), dashboard panel with Start/Try again, photos deleted when done | done — e2e on a prod build in local mode: upload → dispatch → train (stand-in GPU) → splats on the tour; wrong secret 401; another scan's model 409 |
| GPU worker (`worker/photoreal`): gsplat MCMC recipe, discs on the seeds, per-photo exposure and pose, people masked out, `.spz` v3 under 45 MB; Modal app | done — deployed on Modal |
| Trainer fixes: MCMC noise sized to the capture, exposure anchored per photo, Adam only on splats a photo shows; room-shape rules (flat walls/floor/ceiling, needle cap, floaters cleared) | done — 16 CPU tests; synthetic apartment on the GPU (round 3): ahead of the painted model on PSNR/SSIM at every kind of view ([table](prototypes/photoreal/results/round-3/painted-vs-photoreal.md)); first real home: a 199-photo bedroom, 24 min, 1M splats, training PSNR 28.1 |
| Viewer: **Photoreal** switch (Spark 2.2.0, loaded on first use), photoreal as a starting look | done — in Chromium the splats sit on the painted model with its colors (seed-disc splats 26–46 dB against the painted view at 6 spots) |

## Billing ([docs/billing.md](docs/billing.md))

| Piece | Status |
|-------|--------|
| Plans: $19 a listing (first free), $39/month Unlimited, $79/month Pro (5 photoreal a month, then $15), photoreal $20 a listing and free during the beta; exempt accounts | done |
| Stripe Checkout (prices by lookup key, created on first use), return page, signed webhook, customer portal (plan switches, cancelling, cards, invoices) | done |
| Gates: publishing, photoreal from the dashboard and from the phone (the job waits; paying starts it; the phone never shows prices); **Plans & billing** page | done |
| Supabase: billing tables (owner-read RLS, server-only writes), a trigger that refuses unpaid publishes from a realtor's own session, live listings carried over when charging starts | done — migration and trigger tested on Postgres 16, the store and RLS through PostgREST |
| End to end against a Stripe stand-in, prod build, headless Chromium: billing on (74 checks), off, and on during the beta | done |

## Photoreal prototype (`prototypes/photoreal`)

| Piece | Status |
|-------|--------|
| Synthetic apartment with ground truth: the demo scan rendered as a real home (real furniture shapes, clutter, two mirrors, a glossy floor, window views); 665 scan-like photos at 480 × 360 plus 12 held-out views | done |
| Painted models from those photos with the phone's own code (`scanproc paint`): today's boxes and build 7's LiDAR shapes | done |
| Gaussian splats on the CPU: C++ tile rasterizer with a hand-written backward pass (gradient-checked), PyTorch projection/SH/Adam, densify/prune/opacity resets, `.spz` export | done: 12,000 steps, 549k Gaussians, 2.7 h on 4 cores; the screen-size prune is now off (in rooms it deleted 45% of the splats and cost 3 dB) |
| Comparison page (published artifact): the same camera for all three, the real photo, 12 scored views, notes | done: PSNR today 20.70 / build 7 23.29 / splats 29.26 dB (SSIM 0.806 / 0.851 / 0.939); splats lead at all 12 views. three.js's splat viewer is patched to the trained kernel (its defaults cost 2.3 dB) |
| A benchmark as messy as a real scan (`tools/roughen.py`, `bench_paint.sh`, `score.py`, `pose_error.py`): ARKit-like swollen LiDAR meshes, drifting poses, auto-exposure | done: build 7 drops 23.40 → 21.22 dB on it; pose drift costs 1.9 dB, the meshes 0.5, exposure 0.1. Build 8 gets back to 22.00; the rest is drift shared by neighbouring photos, which needs per-photo LiDAR depth to anchor |

Verdict so far: photoreal is far closer to the real rooms (window views, reflections, plants), at the cost of a cloud GPU step (15–30 min, ~$0.25–1 per listing), uploading the photos (100–400 MB; today they stay on the phone) and a 9 MB download. Suggested: ship build 7 now, add photoreal as a cloud upgrade.

Next: deploy the worker on Modal (the user adds `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` to the environment) and set `PHOTOREAL_GPU_URL` / `PHOTOREAL_WORKER_SECRET` on Vercel; the first real GPU run on the user's bedroom and on an empty house; per-photo LiDAR depth to anchor drift; 360° photo spots at the waypoints; turn email confirmation back on before opening sign-ups.
