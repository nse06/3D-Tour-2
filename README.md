# Atrium — 3D property walkthroughs

> **Walk through a property with your phone once, and turn it into a 3D walkthrough that buyers can explore from anywhere.**

Atrium is a web platform for realtors. A listing gets a shareable link (`/tour/1234-sheridan-road`) that drops buyers straight into an immersive, first‑person 3D walkthrough of the home: they glide room to room, look around, climb the stairs, and always see where they are on a live floor plan.

This repository holds the **web app** (realtor dashboard, publishing flow, 3D viewer) and the **Atrium Capture iPhone app** ([`ios/`](ios/README.md)), which scans a home room by room with LiDAR (RoomPlan), records the path walked between rooms, and sends the finished walkthrough to a listing. Uploaded `.glb` models and the bundled demo home use the same pipeline.

It is deliberately **not** a photo gallery, slideshow, hotspot tour or listing site. The 3D walkthrough is the product.

---

## Quick start

```bash
npm install
npm run dev
```

| URL | What |
| --- | --- |
| `http://localhost:3000/` | Landing page |
| `http://localhost:3000/tour/sample` | The demo home (always available, no database) |
| `http://localhost:3000/dashboard` | Realtor dashboard |

No configuration is needed. Listings are stored in `./.data/` (a local JSON store), and you're signed in as a single "Demo Realtor". Set up Supabase for real deployments (see [Persistence](#persistence--auth)).

### The MVP flow (≈1 minute)

1. Open **/dashboard** and click **New listing**.
2. Click **Fill with sample listing** to load *1234 Sheridan Road, Wilmette, IL — $2,495,000 · 5 bd · 4.5 ba · 4,200 sq ft*.
3. Under *3D capture*, keep **Sample capture** selected, or upload `public/demo/sheridan-road.glb` to go through the real upload pipeline.
4. **Create listing**. Floors, rooms and waypoints are created from the capture's scan manifest.
5. **Publish tour**. Copy the public link: `/tour/1234-sheridan-road`.
6. Open it in any browser (no sign-in): **Enter the home** → drag to look → click the floor to walk → use the room list, **‹ ›** or **Guided tour** → switch floors → open the floor plan and **property details** → **Share**.

---

## The buyer experience

* **First-person 3D** (Three.js / React Three Fiber), with a full-screen viewer and a minimal overlay.
* **Guided, path-based navigation.** Each room has a camera waypoint. Moving between rooms follows a walkable route through doorways and **up the staircase**, using cinematic camera motion: eased acceleration, facing the direction of travel, then settling on the room's best view.
* **Look around** by dragging (mouse or touch), with inertia. Pinch or scroll to zoom.
* **Limited free movement.** Click/tap the floor to step there (a hover ring shows where), or walk with the arrow keys/WASD, constrained to room footprints.
* **Room & floor navigation**: room list grouped by floor, previous/next controls, keyboard (`N`/`P`, `[`/`]`), and **Guided tour** autoplay with a slow look-around at each stop.
* **Live floor plan** for each level, showing your position and view direction. Click any room to go there.
* **Property information** drawer (price, beds, baths, sq ft, description) and **Share** (native share sheet on phones, copy link on desktop).
* Polished details: a loading screen with byte-level progress, title cards as you arrive in each room, ambient occlusion on desktop GPUs, and a portrait-aware field of view on phones.

## The realtor dashboard

* **Listings**: cards with cover photo, address, price, status (Published/Draft), room count, and **View tour / Edit / Share**.
* **Create & edit listings**: address, title, price, beds, baths, square footage, description.
* **3D capture**: attach the bundled sample capture, or **upload a `.glb`/`.gltf`**. The browser uploads directly to storage via a signed URL, with progress. If the file carries a scan manifest, rooms are created automatically.
* **Rooms & viewpoints editor**: walk the model (drag + WASD, click the floor), **add a room at the current view**, rename, reorder (this is the guided-tour order), re-aim a viewpoint, manage floors, and **use the current view as the cover photo**. Rooms that can see each other are auto-linked so the viewer glides between them. Unlinked rooms use a quick fade.
* **Preview → Publish → Share**: preview privately, then publish to get a public `/tour/<address-slug>` link.

---

## Architecture

```
            TODAY                                   FUTURE (not built yet)
 ┌──────────────────────────┐            ┌───────────────────────────────────────┐
 │ Bundled demo .glb        │            │ iPhone app: RoomPlan + ARKit + LiDAR  │
 │ Uploaded .glb / .gltf    │            │   → scan package (rooms, trajectory,  │
 └────────────┬─────────────┘            │     RGB frames) → upload               │
              │                          │   → backend processing job             │
              │                          └───────────────────┬───────────────────┘
              ▼                                              ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  Capture = 3D asset (.glb)  +  scan manifest (floors, room polygons,  │
   │            camera waypoints, walkable links)                          │
   └───────────────────────────────────┬───────────────────────────────────┘
                                       ▼
            Property → Tour → Floors → Rooms (waypoints) + nav links      (Postgres / local JSON)
                                       ▼
                     The same web viewer at /tour/<slug>
```

The viewer only ever receives `TourData` (a 3D asset URL plus a `TourSpace`). It doesn't know whether the model came from the demo, a manual upload, or a future LiDAR scan.

### Spatial data model

`Property → Tour → Floors → Rooms → Waypoints`, never `Property → Photos`.

| Table | Key fields |
| --- | --- |
| `properties` | `id, user_id, slug, address_line, city, state, postal_code, title, price, bedrooms, bathrooms, square_feet, description, cover_image_url, published, created_at` |
| `tours` | `id, property_id, asset_url, asset_format, source ('demo'\|'upload'\|'ios_scan'), scan_package_url, processing_status, navigation (links + eye height), published, created_at` |
| `floors` | `id, tour_id, name, floor_number, elevation, outline, features (stairs, open-to-below)` |
| `rooms` | `id, floor_id, name, sort_order, waypoint_position [x,y,z], waypoint_rotation {yaw,pitch}, footprint [[x,z]…]` |

See `supabase/migrations/20261007000000_init.sql` (row-level security: realtors manage only their own listings; anyone can read a published tour). TypeScript types live in `src/lib/tour/types.ts` and `src/lib/data/types.ts`.

### The scan manifest

A capture can embed its spatial structure in the glTF scene extras (`scenes[0].extras.atrium`). The demo `.glb` does. On upload, the browser reads just the glTF header and JSON chunk (no geometry), and the server creates floors, rooms and links from it (`src/lib/tour/scan-manifest.ts`).

```jsonc
{
  "schema": "atrium.scan-manifest/v1",
  "units": "meters", "upAxis": "y", "eyeHeight": 1.6,
  "floors": [{ "key": "main", "name": "Main Level", "level": 1, "elevation": 0,
               "outline": [[x, z], …], "features": [{ "type": "stairs", "polygon": [[x, z], …] }] }],
  "rooms":  [{ "key": "kitchen", "name": "Kitchen", "floor": "main", "order": 3,
               "footprint": [[x, z], …],
               "waypoint": { "position": [x, y, z], "yaw": 0.79, "pitch": -0.1 } }],
  "links":  [{ "from": "entry", "to": "kitchen", "via": [[x, y, z], …], "kind": "door" }]
}
```

**How the future iPhone capture maps onto it:** RoomPlan's `CapturedStructure` gives floors and room polygons (`floors`, `rooms[].footprint`). The ARKit camera trajectory gives where the realtor actually walked, which becomes waypoints (good viewing positions per room) and links (the walked path through doorways and stairs). The textured mesh becomes the `.glb`.

### Navigation (and room for free movement later)

`src/lib/tour/navigation.ts` treats rooms as graph nodes and links as edges whose `via` points thread the camera through doorways. Routes come from Dijkstra's algorithm and are smoothed with a centripetal Catmull–Rom curve in `src/components/tour/CameraRig.tsx`. Free movement today is "click the floor / arrow keys within room footprints". Full free roaming can be added later by swapping footprints for a navmesh derived from the scan. The viewer only asks *"is this point walkable?"* and *"give me a path from A to B"*.

---

## iPhone capture (Atrium Capture)

Install, pairing and scanning guide: **[ios/README.md](ios/README.md)**. Contracts: [docs/iphone-capture.md](docs/iphone-capture.md).

1. In the dashboard, a listing's **Connect an iPhone** shows a QR code (a one-day pairing token, stored hashed).
2. The app scans room by room with RoomPlan in one continuous AR session, so every room and the walked path share one coordinate space; the realtor names each room.
3. On the phone, ScanCore (`ios/ScanCore`, a Swift package that also runs on Linux) turns the rooms and the path into the walkthrough `.glb` with an embedded scan manifest: floors, room footprints, viewpoints chosen from where the realtor stood, and links through doorways and along the walked route.
4. The app uploads the model and a raw scan package straight to storage (`/api/capture/sessions/<token>/…`), then the server attaches it to the listing (`source = 'ios_scan'`, `scan_package_url`) and the dashboard refreshes. No manual 3D work.

CI builds an unsigned `.ipa` (sideload with Sideloadly/AltStore), runs the app in a simulator against a mock server, and can upload to TestFlight.

---

## Persistence & auth

| Mode | When | Data | Files | Auth |
| --- | --- | --- | --- | --- |
| **Local** (default) | no Supabase env vars | `.data/db.json` | `.data/uploads/` via signed PUT → `/api/assets/*` | single implicit realtor |
| **Supabase** | `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Postgres with RLS | Storage bucket `captures` (direct browser upload to signed URLs) | email + password (`/login`), session refreshed by `src/proxy.ts` |

Setup for Supabase:

1. Create a project.
2. Run `supabase/migrations/20261007000000_init.sql`. This creates tables, RLS policies, the `available_slug` helper and the public `captures` bucket with per-user folder policies.
3. Copy `.env.example` to `.env.local` and fill in the URL and anon key.

The repository interface (`src/lib/data/repository.ts`) has two implementations, `local-store.ts` and `supabase-store.ts`, so the rest of the app is storage-agnostic. Uploads always go browser → storage through short-lived signed URLs, so large scans never pass through a serverless request body.

## Deploying (Vercel)

1. Import the repo into Vercel (framework: Next.js).
2. In the Vercel project: **Storage → Create Database → Supabase**, connected to the project. This sets every variable Atrium needs (URL, keys, and `POSTGRES_URL_NON_POOLING`).
3. Deploy, then open the dashboard. The first visit creates the database tables, security policies and storage bucket by itself (`src/lib/migrations.ts`, tracked in `public.atrium_migrations`; upgrades apply on the next visit to `/setup`). If the deployment has no direct database URL, `/setup` shows the SQL to paste instead.

Sign-ups are confirmed immediately when the server has the Supabase admin key. Without Supabase, a deployment still runs but has nowhere durable to keep listings, so the dashboard sends you to `/setup`. `/tour/sample` always works.

### Password reset emails

**Forgot your password?** on the sign-in page sends Supabase's reset email, whose link lands on `/auth/callback` and then
`/reset-password` (signed-in realtors reach that page from **Change password** too). Set up once in Supabase:

1. **Authentication → URL Configuration**: **Site URL** = the site's address, and add `https://<your site>/**` to
   **Redirect URLs**. Otherwise the emailed link leads to `localhost`.
2. Optional, so the link works from any device (the default only works in the browser that asked for it):
   **Authentication → Email Templates → Reset password**, link to
   `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery`.
3. Supabase's built-in email only reaches the project's own team members. Before other realtors sign up, add an
   SMTP sender (**Authentication → SMTP Settings**, e.g. Resend or Postmark).

### Billing (Stripe)

Realtors pay on the website with Stripe Checkout: **$19 a listing** (the first one free) or **$39/month** for unlimited
listings; photoreal walkthroughs are **$20 a listing**, or **$79/month Pro** with 5 a month included ($15 after that).
Photoreal is free for founding agents during the beta. Everything is free until `STRIPE_SECRET_KEY` is set. To turn
billing on, add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Vercel and point a Stripe webhook at
`https://<your site>/api/stripe/webhook`. Stripe's products and prices are created on first use. The steps, the
events to send, and how listings are covered are in [docs/billing.md](docs/billing.md).

---

## Project structure

```
scripts/
  generate-demo-property.mjs      # builds the demo capture (npm run generate:demo)
  demo-house/                     # procedural house: plan, furniture, textures, glTF export
public/demo/
  sheridan-road.glb               # demo capture (meshopt-compressed, ~1.9 MB, embedded manifest)
  sheridan-road-cover.jpg
supabase/migrations/              # schema + RLS + storage policies
src/
  app/
    page.tsx                      # landing
    tour/[slug]/page.tsx          # PUBLIC shareable tour
    dashboard/…                   # listings, new, [id], [id]/rooms, [id]/preview + server actions
    login/                        # Supabase auth
    dashboard/billing/            # plans, Stripe checkout and portal (docs/billing.md)
    api/                          # signed uploads, local asset serving, Stripe return + webhook
  components/
    tour/                         # TourViewer (overlay UI), TourScene (R3F), CameraRig, FloorPlan
    dashboard/                    # PropertyForm, CaptureUploader, RoomEditor, publish controls
  lib/
    tour/                         # types, navigation, scan manifest, space validation
    data/                         # repository + local / Supabase implementations
    billing/                      # plans, who pays for what, Stripe, billing records
    demo/                         # demo listing + manifest
  proxy.ts                        # Supabase session refresh / dashboard guard
```

## The demo property

*1234 Sheridan Road, Wilmette, IL* is a fictional North Shore Georgian. Its capture is generated procedurally (`npm run generate:demo`), so it's reproducible and editable:

* **Main level:** double-height entry with chandelier and staircase, living room with fireplace and built-ins, dining room, kitchen with waterfall island and breakfast nook, green-paneled library office.
* **Upper level:** landing overlooking the foyer, primary bedroom with sitting area, primary bath (freestanding tub, walk-in shower, double vanity), bedrooms 2 and 3.

About 120k triangles, PBR materials with procedural textures (oak, marble, walnut, rugs, art), 16 lights, and contact shadows. Compressed with meshopt and quantization to about 1.9 MB, and embeds its scan manifest.

## Development notes

* `npm run lint`, `npm run typecheck`, `npm run build`, `npm run format`.
* Next.js 16 (App Router, Turbopack). `cacheComponents` is intentionally off; data pages use `dynamic = "force-dynamic"`. Read `node_modules/next/dist/docs/` before changing framework-level code (see `AGENTS.md`).
* Viewer QA: `?ao=0` / `?ao=1` toggles ambient occlusion. `window.__atrium` exposes the viewer API (`api.current.goToRoom(id)`, `setPose(pose, true)`, `getPose()`) for automated checks.

### Known limitations (by design for the MVP)

* iPhone scans are RoomPlan geometry (walls, openings, styled furniture boxes), not photo-textured meshes; RGB keyframes are uploaded in the scan package for future texturing.
* `.gltf` uploads must be self-contained (embedded buffers). Use `.glb` otherwise.
* One active capture per listing. Saving rooms replaces the tour's floors and rooms; in Supabase mode that is a short sequence of statements rather than a single transaction.
* Uploaded models without a manifest get rooms and auto-links from the editor, but no footprints. Their floor plan shows room markers instead of polygons.
