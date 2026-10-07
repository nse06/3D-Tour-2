# iPhone capture — architecture & contracts

This document is the contract between the three pieces of the iPhone capture pipeline:

```
 AtriumCapture (iOS app)                    ScanCore (Swift package)                 Atrium web (Next.js)
 ─────────────────────────                  ────────────────────────                 ────────────────────
 RoomPlan multi-room capture   ──scan.json──▶ CaptureScan ─▶ meshes + manifest ─▶ .glb ──upload──▶ /api/capture/sessions/*
 ARKit camera trajectory                     (platform independent, Linux-tested)      attach capture (source = ios_scan)
 keyframes (RGB) + raw RoomPlan                                                         floors / rooms / waypoints / links
          └────────────── scan package (.zip) ─────────────────────────────────────────▶ tours.scan_package_url
```

* **AtriumCapture** (`ios/AtriumCapture`, iOS 17+, SwiftUI): runs the scan, names rooms, converts each Apple
  `CapturedRoom` into a portable `RoomPart`, has ScanCore put the rooms into one frame (§1.1) and build the
  walkthrough, uploads.
* **ScanCore** (`ios/ScanCore`, Swift package, no Apple-only frameworks): turns a `CaptureScan` into a glTF binary
  with an embedded *scan manifest*. Builds and tests on Linux and macOS; also ships a `scanproc` CLI so the same
  processing can run on a server later.
* **Atrium web**: pairs a phone with a listing, receives uploads, and creates the walkthrough from the manifest.

Coordinate system everywhere: **ARKit world space** — right-handed, **+Y up (gravity aligned), meters**. This is also
glTF's convention, so no axis conversion happens anywhere. The viewer's yaw convention: a camera with yaw `θ` looks
along `(-sin θ, 0, -cos θ)`; pitch `> 0` looks up.

---

## 1. `CaptureScan` (scan.json) — `atrium.capture-scan/v1`

Produced by the app's RoomPlan adapter; the single input of ScanCore. All positions in world space.
`transform` values are 4×4 matrices as 16 floats in **column-major** order (same memory layout as `simd_float4x4`
and glTF `matrix`).

```jsonc
{
  "format": "atrium.capture-scan/v1",
  "capturedAt": "2026-10-07T18:00:00Z",
  "device": { "model": "iPhone16,1", "system": "iOS 18.1", "app": "1.0 (1)" },
  "rooms": [{
    "id": "8F2C…",                    // stable id (UUID string)
    "name": "Living Room",            // what the realtor named it (or RoomPlan's detected label)
    "label": "livingRoom",            // optional RoomPlan section label (raw)
    "captureIndex": 0,                // order in which rooms were scanned
    "floorPolygon": [[x,y,z], …],     // world-space floor outline (≥3 points, any winding, not closed)
    "floorY": 0.02,                   // floor height
    "ceilingY": 2.61                  // ceiling height (top of the room's walls)
  }],
  "walls": [{
    "id": "…", "roomId": "8F2C…",     // optional: the room it was scanned from (finds its inside face)
    "transform": [16 floats], "width": 4.2, "height": 2.6
  }],
  "openings": [{
    "id": "…", "kind": "door" | "window" | "opening", "isOpen": true,
    "wallId": "…" | null,             // parent wall (RoomPlan parentIdentifier), may be null
    "roomId": "…",                    // optional
    "transform": [16 floats], "width": 0.9, "height": 2.05
  }],
  "objects": [{
    "id": "…", "category": "sofa",    // RoomPlan CapturedRoom.Object.Category case name (see §3.4)
    "roomId": "…",                    // optional
    "transform": [16 floats], "size": [x, y, z]
  }],
  "trajectory": [{ "t": 12.4, "p": [x,y,z], "f": [x,y,z] }],  // seconds since start, camera position, camera forward (−Z axis) in world
  "frames": [{                        // optional: photos taken while scanning (see §3.3), same frame as everything else
    "file": "frames/000012.jpg", "t": 18.5, "transform": [16 floats],   // camera-to-world (ARKit camera convention)
    "intrinsics": [9 floats], "width": 1920, "height": 1440, "imageWidth": 1280, "imageHeight": 960
  }]
}
```

Surface conventions (RoomPlan): the transform origin is the **center** of the surface rectangle / object box; for
walls and openings column 0 (X) runs **along the width**, column 1 (Y) is **up**, column 2 (Z) is the surface normal;
`width`/`height` are the full extents. Objects: `size` is the full bounding-box extent along the transform's X/Y/Z.
ScanCore must not assume the normal points into any particular room, and must tolerate transforms with tiny
non-orthogonality.

### 1.1 Rooms arrive in separate frames — `RoomAlignment`

RoomPlan moves the AR world origin to the phone's position each time a room capture starts (RoomCaptureView calls
`ARSession.setWorldOrigin`, a pure shift), even though the AR session keeps running between rooms. Every room of a
multi-room scan — and the path and photos recorded from its start until the next room starts, its *segment* — is
therefore expressed relative to where that room's scan began. Taken as-is, the rooms pile up on top of each other
(`docs/img/alignment-before.png`). RoomPlan's `StructureBuilder` merges them using tracking data apps can't read.

The app records, with every raw path sample and photo, the RoomPlan run it was taken in (`"segment": 2`; raw files
only), and samples the path at 30 Hz for 3 s after each run starts. `RoomAlignment.align(parts:structure:path:frames:)`
then places each room, best method first:

1. **Structure fit** — the merged `CapturedStructure` keeps the identifiers of walls, doors, windows, openings and
   objects. The turn about +Y and shift that best map a room's elements onto the merged ones place the room (walls
   only constrain their normal, since the merge may resize them; a 180°-flipped answer is ruled out by positions).
2. **Path links** — at each origin reset the recorded path jumps back to (0, 0, 0); the jump measures the shift
   between consecutive frames. Rooms without a structure fit, and path samples and photos of runs without a room
   (rescans), are chained through these links. Scans from builds 1–2 have no run tags: resets are found in the
   path, and extra runs left by rescanned rooms are skipped by trying each assignment and keeping the one where
   rooms don't overlap and the path stays continuous.
3. **Doorway snapping** — for path-placed rooms only, a doorway seen from both of its rooms pulls the rooms back
   together when the two views are further apart than RoomPlan's own noise (~0.2 m along the wall; the gap between
   the views, i.e. the partition, from −0.4 to +0.12 m). Rooms on the merged structure never move.

The result is a `CaptureScan` in one frame plus an `AlignmentReport` (method, matched elements and residual per
room), saved as `alignment.json`. Checked on Apple's 11-room sample with each room shifted into its own frame:
every room returns exactly with the merged structure, and within 0.12 m from a 4 Hz path alone
(`scanproc align … --scramble [--walk --no-structure]`).

## 2. ScanCore API

```swift
public struct ScanProcessorOptions { eyeHeight = 1.6, wallThickness = 0.12, includeCeilings = true, includeLights = true }
public struct ProcessedScan { public let glb: Data; public let manifest: ScanManifest; public let stats: ScanStats }
public protocol PhotoSource { func image(for frame: CameraFrame) -> RGBImage? }   // decoded photo, sensor orientation
public enum ScanProcessor {
  public static func process(_ scan: CaptureScan, options: ScanProcessorOptions = .init(),
                             photos: PhotoSource? = nil, encodeImage: ImageEncoder? = nil,
                             photoOptions: PhotoTexturingOptions = .init()) throws -> ProcessedScan
}
```

With `photos` and `scan.frames`, the model is **photo-textured** (§2.4); otherwise it is the styled model below.

`scanproc <scan.json> <out.glb> [--manifest out.json]` runs the same function from the command line.

Before meshing, the scan is moved into a tidy frame (`normalizeFrame`, on by default): rotated about Y so the dominant
wall direction lies along X, centered in plan, lowest floor at y = 0. The applied transform is recorded in the glTF at
`scenes[0].extras.atriumCapture.frame` (16 numbers, column-major). Each room scanned separately reports its own face of a
shared partition: facing walls less than 0.5 m apart become two slabs that each fill half the gap, and a door seen from
only one side is cut through both faces.

### 2.1 Geometry (meshes, one primitive per material)

* **Walls**: a slab of `wallThickness` centered on the wall plane, with rectangular holes for its openings
  (assigned by `wallId`, else the nearest coplanar wall whose span contains the opening). Pieces: full-height
  segments between openings, plus a sill piece below and a header piece above each opening. Door/opening holes get
  white casing trim on both faces; windows get a sill, a thin dark frame with a mullion, and an emissive
  "daylight" pane set near the outer face.
* **Floors**: each room's `floorPolygon`, triangulated (ear clipping, works for concave rooms), at `floorY`, with a
  procedural wide-plank oak texture (world-space UVs). **Ceilings**: same polygon at `ceilingY`, facing down.
* **Objects**: category-styled furniture built from boxes (beds with a headboard toward the nearest wall, sofas with
  a back toward the nearest wall, tables with legs, cabinets, appliances in steel/black, white ceramics, stairs as
  steps) — see §3.4. Unknown categories become a neutral box.

### 2.2 glTF output

glTF 2.0 binary: JSON chunk padded with spaces, BIN chunk padded with zeros, 4-byte aligned buffer views,
`POSITION` accessors with `min`/`max`, `NORMAL`, `TEXCOORD_0`, `UNSIGNED_INT` indices, PBR metallic-roughness
materials, PNG textures (stored-deflate encoder, no zlib dependency), `KHR_lights_punctual`,
`KHR_materials_emissive_strength`. The manifest is embedded at **`scenes[0].extras.atrium`** (the web reads it
from there without parsing geometry).

### 2.3 Scan manifest — `atrium.scan-manifest/v1`

Identical to the web's `ScanManifest` (`src/lib/tour/scan-manifest.ts`):

* **floors**: rooms are clustered by `floorY` (gap > 1.2 m ⇒ new floor), sorted by height → `level` 1, 2, …;
  names: one floor ⇒ "Main Level"; two ⇒ "Main Level"/"Upper Level"; more ⇒ "Level N". `elevation` = median
  `floorY`. `features`: a `stairs` feature for each stairs object (its footprint).
* **rooms**: `key` = room id, `name`, `floor`, `order` = order of first visit along the trajectory (fallback:
  `captureIndex`), `footprint` = floor polygon in plan (`[x, z]`), `waypoint` (below).
* **waypoints**: candidates = trajectory samples inside the room footprint and on the room's floor, plus the
  footprint's centroid. Score = distance to the farthest footprint vertex (a deep view across the room) with a
  penalty for being within 0.6 m of a wall or inside a furniture footprint. Position = best candidate at
  `floorY + eyeHeight`; yaw looks toward the midpoint between the footprint centroid and the farthest vertex;
  pitch = −0.08.
* **links**: (1) every door/opening whose two sides (0.6 m along the wall normal) fall in two different rooms
  ⇒ link through `[side A, side B]` at eye height; (2) every trajectory transition A → B not already linked
  ⇒ link through the walked samples around the transition (≤ 8 points); transitions between floors are
  `kind: "stairs"` and keep the climb (≤ 12 points); (3) rooms that flow into each other with no wall between
  them (open plan, overlapping scans) ⇒ link through the middle of the open stretch of their shared edge.

### 2.4 Photo-textured model (`PhotoTexturing.swift`)

The photos taken while scanning (`CaptureScan.frames`, ~1 every 1.5 s) are painted onto the model, so the
walkthrough shows the real walls, floors, art, windows and furniture:

* **Geometry**: every wall's inside face is one flat *chart* (pieces between holes share it, so no seams), each
  room's floor and ceiling is a chart, and each object is a box with a chart per visible face. Only doorways with a
  scanned room on both sides are cut; other doors and windows stay on the wall, where the photos show them (and the
  view through the window). Outsides and tops of walls and reveals get a plain material.
* **Atlases**: charts are packed (shelf packing, 4-texel padding) into up to `maxAtlases` atlases of `atlasSize`²
  (defaults 3 × 2048²) at `texelSize` (1.2 cm), coarsened until everything fits.
* **Baking**, two passes so only one photo is decoded at a time: (1) geometry only — for every texel the up to three
  photos that see it best: facing it, close, near the image center, and not hidden by other surfaces (a 192-pixel
  depth image per photo, rasterized from the model; a texel counts as hidden if the nearest of the four depth pixels
  around it is clearly nearer); (2) photo by photo — each photo's pixels are blended into the texels that chose it,
  weighted toward the best view. Texels no photo saw are filled smoothly from their neighbours (pull-push); charts
  no photo saw get a neutral color. If the photos cover less than 15% of the surfaces, the styled model is built
  instead.
* **Output**: one material per atlas with the photo as base color (JPEG from the app, PNG elsewhere), clamped
  sampling, `KHR_materials_unlit` on every material and no lights (the lighting is in the photos). The manifest says
  `"appearance": "captured"`, which the web app uses as the tour's default look; `ScanStats.photoCoverage` is the
  share of surfaces the photos covered. Tested by ray-casting photos of a room whose surfaces are colored by
  position: seen texels reproduce the pattern, and a cabinet never leaks onto the wall behind it.
* **Lights**: one warm point light per room (`KHR_lights_punctual`), 0.6 m below the ceiling at the room's visual
  center, intensity scaled by floor area.

## 3. Atrium web API (phone ⇄ server)

### 3.1 Pairing

The realtor opens a listing in the dashboard → **Scan with iPhone** → the server creates a *capture session*
(random 32-byte token, stored as SHA-256, expires in 24 h) and shows:

* a QR code and a button for the deep link `atriumcapture://pair?server=<url-encoded base URL>&token=<token>`
  (the iPhone Camera app opens the app from the QR code);
* the base URL is `NEXT_PUBLIC_SITE_URL`, else the request origin — except when the dashboard is opened on
  `localhost`, where the server substitutes the machine's LAN IPv4 address so the phone can reach it.

### 3.2 Endpoints (token in the path; no cookies)

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/capture/sessions/{token}` | — | `{ property: { id, addressLine, city, state }, expiresAt }` or 404 |
| `POST /api/capture/sessions/{token}/uploads` | `{ kind: "capture" \| "package", filename, size }` | `{ method: "PUT", url, headers, assetUrl }` — `url` may be relative (resolve against the base URL) |
| `POST /api/capture/sessions/{token}/complete` | `{ assetUrl, packageUrl \| null, manifest }` | `{ ok, rooms, floors, propertyUrl, previewUrl }` |

Files go straight to storage with `PUT` (local signed URL or Supabase Storage signed upload URL) — large scans never
pass through a serverless function body. `complete` validates that both URLs belong to this user/property, validates
the manifest, attaches the capture with `source = "ios_scan"` and `scan_package_url`, and marks the session complete.
In Supabase mode these endpoints need `SUPABASE_SERVICE_ROLE_KEY` (the phone has no user session).

### 3.3 Scan package (`package.zip`)

```
scan.json            CaptureScan (reprocess with `scanproc`)
manifest.json        the generated scan manifest
roomplan/structure.json   CapturedStructure (JSONEncoder) — raw Apple data for future processing
roomplan/room-N.json      each CapturedRoom (RoomBuilder output)
roomplan/room-N-data.json each CapturedRoomData (raw capture, can be rebuilt with RoomBuilder)
roomplan/structure.usdz   RoomPlan's own USDZ export
roomplan/capture.json     what a rebuild needs besides RoomPlan's files: startedAt, device, rooms
                          [{ name, file: "room-N.json", segment }], path (raw: each sample in its run's frame)
frames/frames.json   [{ file, t, transform[16], intrinsics[9], width, height, imageWidth, imageHeight, segment }]
                     (raw: each pose in its run's frame; images are downscaled, in sensor orientation;
                     intrinsics refer to width × height; scan.json has the same photos in the shared frame)
frames/000123.jpg    RGB keyframes (~every 1.5 s, ≤1280 px) for photo texturing
alignment.json       AlignmentReport: how each room was placed (§1.1)
info.json            app / device / capture metadata, pipeline version, alignment summary
```

### 3.4 Object categories → styles

`storage` cabinet · `refrigerator` steel column · `stove` / `oven` black+steel · `dishwasher` steel ·
`sink` white counter · `washerDryer` white box · `toilet` white ceramic · `bathtub` white tub with water ·
`bed` base + mattress + duvet + headboard · `sofa` seat + back + arms · `chair` seat + back · `table` top + legs ·
`fireplace` stone · `television` black panel · `stairs` steps · anything else: neutral box.

## 4. AtriumCapture app (iOS 17+, iPhone with LiDAR)

### 4.1 Screens & flow

1. **Home** — serif "Atrium Capture" title, brand colors (ink `#161514`, paper `#F7F4EF`, gold `#B8955A`).
   * Connection card: if paired, "Scanning for **1234 Sheridan Road** · uploads to `host`"; otherwise
     "Open a listing in the Atrium dashboard and tap **Scan with iPhone** to connect" (scans can still be made and
     shared as files without pairing).
   * **Start a scan** (disabled with an explanation when `RoomCaptureSession.isSupported` is false: "Needs an iPhone
     with LiDAR — iPhone 12 Pro or newer Pro model").
   * List of saved scans (date, rooms, floors, status: *Saved*, *Uploading 42%*, *Sent to Atrium*).
2. **Capture** (full screen) — RoomPlan's live view with its own coaching. Top: "Room N" + Cancel. Bottom:
   **Done with this room**. After a room finishes: a sheet "What is this room?" with a text field prefilled from
   RoomPlan's detected label and quick chips (Living Room, Kitchen, Dining Room, Bedroom, Primary Bedroom, Bathroom,
   Office, Hallway, Entry, Laundry), then **Scan next room** or **Finish**. Between rooms: "Walk to the next room —
   keep the phone pointed ahead. Your path becomes the tour route." The ARKit session (and the trajectory
   recording) keeps running between rooms; RoomPlan still starts each room in a new frame, which §1.1 undoes.
3. **Processing** — steps with checkmarks: Combining rooms → Building 3D model → Packaging scan.
4. **Scan detail** — summary (rooms, floors, floor area), then:
   * **Send to Atrium** (when paired) with upload progress → success with **Open listing in Atrium**;
   * **Share 3D model (.glb)** (AirDrop / Files — can be uploaded in the dashboard by hand);
   * **Preview** (AR Quick Look of RoomPlan's USDZ);
   * **Rebuild walkthrough** — re-processes the saved RoomPlan data with the current pipeline (no rescanning);
     scans built by an older pipeline (`record.pipeline` < `ScanBuilder.pipelineVersion`) show it as a
     "Fix overlapping rooms" card. A rebuilt scan has to be sent again;
   * **Delete**.

### 4.2 Deep link

`atriumcapture://pair?server=<url>&token=<token>` → the app calls `GET {server}/api/capture/sessions/{token}`,
stores the pairing (server, token, property label, expiry) and shows it on Home. A new link replaces the old one.

### 4.3 Storage on device

`Documents/Scans/<scan-id>/`: `scan.json`, `scan.glb`, `manifest.json`, `alignment.json`, `roomplan/…`
(including `capture.json`), `frames/…`, `info.json`, `package.zip` (built on demand, deleted on rebuild), and
`record.json` (app metadata: name, created, stats, upload state, pipeline version, alignment summary).

### 4.4 Requirements

iPhone/iPad with LiDAR, iOS 17+. Building requires a Mac with Xcode 16 or newer and a free Apple ID (Personal
Team). Uploading to a dashboard running on a laptop requires both devices on the same Wi-Fi; a deployed
(HTTPS) dashboard works from anywhere.
