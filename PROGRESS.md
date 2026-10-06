# Build progress

Tracks the MVP milestones so work can resume automatically after a pause.
Branch: `claude/3d-real-estate-tour-mvp-pxgyqw`

| # | Milestone | Status |
|---|-----------|--------|
| 1 | App setup + demo property (generated `.glb` + scan manifest) | in progress |
| 2 | Three.js 3D viewer | todo |
| 3 | Room/floor navigation + camera waypoints + floor plan | todo |
| 4 | Realtor dashboard + property creation + capture upload | todo |
| 5 | Public shareable tour URLs (`/tour/[slug]`) + publish flow | todo |
| 6 | Polish (design, loading, mobile, README) | todo |

## Notes
- Next.js 16 (App Router, Turbopack), React 19, Tailwind v4, React Three Fiber.
- `cacheComponents` is intentionally disabled; data pages use `dynamic = "force-dynamic"`.
