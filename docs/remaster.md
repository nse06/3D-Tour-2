# Remastered models

A photo scan's walkthrough is the **painted model**: RoomPlan's walls, floors and furniture (and the LiDAR's
shapes), with the photos painted on by the phone (docs/iphone-capture.md §2.4). The **remastered model** is the same
model rebuilt on a cloud GPU from the photos kept on the server: skins learned from every photo at once, spots no
photo saw filled in by an AI, and, step by step, AI-cleaned photos, AI-made furniture, trim and photo spots. It's a
look of its own, next to photos on/off and photoreal, and the realtor chooses which one buyers see.

It's a **separate process from the photoreal splats** (docs/photoreal.md): its own worker (`worker/remaster`, package
`atrium_remaster`), its own Modal app (`atrium-remaster`), its own jobs (`remaster_jobs`), its own file on the tour
(`tours.remaster_url`) and its own look (`appearance = "remastered"`). It only borrows the photos a photoreal upload
left on the server (docs/photoreal.md §2.1), so either can be switched off, redeployed or dropped without the other.

| Idea | Stage | Status |
|---|---|---|
| Train the skins on every photo | `skins.py` (§2) | built; GPU eval on the synthetic apartment (round 2): within about 1 dB of the painting on plain walls, 0.7–1 dB better on textured spots and at an angle |
| Fill spots no photo saw | `fill.py` (§3), LaMa | built (LaMa on the GPU, pull-push in tests) |
| Clean up the photos (sharpen, TV off, windows) | `cleanup.py` (§4.1), NAFNet | built |
| The Fixer's cleaned views feed the skins | `fixviews.py` (§4.2) | built; off unless asked (`fixerViews`): nothing gained on the synthetic apartment, for a GPU more |
| Sharper depth from AI | `depth.py`, `fuse.py` (§4.3), Prompt Depth Anything | built: photo pixels where the shape is wrong say nothing; the LiDAR's pieces fused anew from it |
| AI-made furniture | `furniture.py` (§4.4), SAM 2.1, TripoSG | built: fitting tested on CPU; TripoSG's GPU run next |
| Trim: doors and windows set into their walls, baseboards, crown moldings, casings, cabinet doors | `trim.py` (§4.5) | built; the doors, windows, casings and cabinets wait for a build-13 scan; white baseboards on off-white walls are mostly too faint in the phone's painting to be found |
| The room layout from the phone (walls, doors, windows, furniture boxes) | build 13, `cameras.json` `layout` (docs/photoreal.md §1) | done |
| Photo spots (Matterport-style) | `spots.py`, viewer's `PhotoSpots` (§4.6) | built: tested on CPU and in Chromium on a synthetic room |

## 1. Flow

1. The phone sends the scan, then **Make it photoreal** uploads its photos (`cameras.json`, `seeds.ply`, `frames/`,
   `masks/`) for photoreal; they stay on the server afterwards.
2. On the listing page, **Remaster with AI** (`startRemasterAction`) creates a `remaster_jobs` row for the listing's
   current tour, pointing at the upload whose photos it uses (`inputs_job_id`), and hands it to the remaster GPU
   (`REMASTER_GPU_URL`) with signed links to the photos and the painted model's URL (`lib/remaster.ts`). Photos a
   queued or running remaster uses aren't deleted, even when a newer upload replaces them, and **Delete the photos**
   waits for it.
3. The worker reports to `/api/remaster/jobs/<id>` (§5) and uploads `model.glb` (storage kind `remaster`). Done, the
   model goes on the tour (`tours.remaster_url`) unless the listing was sent a new scan since, or a newer remaster of
   the same scan finished first.
4. Buyers see nothing new until the realtor chooses: on the listing page (**Painted | Remastered**), or in **Rooms &
   viewpoints**' look picker. In the preview, a **Painted | Remastered** switch compares the two from the same spot
   (the viewer loads the other model the first time it's asked for and keeps the camera).

Remastering is covered by the listing's photoreal (the same entitlement; free during the beta, docs/billing.md).

## 2. Skins trained on every photo (`skins.py`)

The phone paints each spot from the one photo that sees it best: a surface becomes a few patches, each from a single
photo, with exposure matched and seams leveled. The remaster keeps the model's shapes and learns its atlases from all
the photos at once, by gradient descent, like the splats, except that nothing can move off the surfaces:

* **Where each pixel lands**: every photo is ray cast against the model (Open3D's `RaycastingScene`, MIT; Embree
  underneath, on the CPU): per pixel the triangle, the spot on it (barycentric weights) and the depth, so the texel it
  sees (`views.py`).
* **What a pixel may say**: nothing within 3 px (at 1920 px) of a jump in depth or a seam between surfaces at more
  than 30° (where a small error in the shapes would put one surface's color on another), nothing more than 78° off
  head-on, nothing where the photo shows people (the phone's masks).
* **Per photo**: a gain and an offset per channel (auto exposure and white balance), started from the ratio of the
  photo's colors to the painting's and kept near it, their average held at the painting's (so what the photos saw
  keeps the brightness of what they didn't); and a small shift, turn and zoom (what lining the photos up on the phone
  left). A full color matrix per photo let the skins trade colors with the photos where few photos look.
* **Smeared photos** are compared with the render smeared the same way (atrium_photoreal's motion smear, its
  direction found once the skins take shape).
* **Finer texels**: the atlases are learned at twice the phone's texel density (8 mm → 4 mm), within 40 M texels for
  the whole home (a multiple of 16 on a side, so mipmaps line up). Each pixel reads the mipmap its footprint covers
  (a floor seen at a grazing angle doesn't alias).
* **Seldom seen texels**: with hundreds of photos, a texel is in a step's photos now and then. The optimizer is a
  lazy Adam: only what a step's photos reach moves, each by its own history. torch's Adam kept every texel moving on
  its momentum and divided a seldom seen texel's next gradient by a variance that had decayed meanwhile; with a
  pyramid of coarser layers on top (a layer's texel a block of the finest), that turned the synthetic apartment's
  665-photo skins into colored blotches (round 1: 18 dB where the painting has 24). The pyramid is gone too
  (`levels` 1).
* **The last steps**: the learning rate eases down (a cosine) to a tenth of itself by the last step (`anneal`), so
  the skins settle on what all the photos say rather than on the last few steps' photos. On the synthetic room that
  took a sixth off the grain on plain walls and a little off the error on new viewpoints. Leaning texels few photos
  saw back to the painting (`confidence`) took more grain off but added error on new viewpoints, so it's off.
* **What no photo saw** keeps the phone's colors exactly; the coverage map goes on to the fill (§3).

On a synthetic room with exact ground truth (`worker/remaster/tests/room.py`: a painted atlas softened, with a
different brightness per chart and a flat patch; 16 photos with different exposures, noise and two smeared), trained
skins cut the error on new viewpoints from 0.129 to 0.074 (the truth at the phone's texel size: 0.055); with 96 photos,
each step one small tile (seldom seen texels), from 0.130 to 0.084, their color left as the photos have it (the old
optimizer: 0.124, with blotches).

On a GPU (an A10G), on the synthetic apartment (665 photos, the eval views of docs/photoreal.md;
`prototypes/photoreal/results/remaster-round-2`), the skins take about 3 minutes and come within about 1 dB of the
painting on plain walls (a wall at 0.6 m: 25.2 dB where the painting has 26.3; at 1.2 m: 24.4 and 24.5) and beat it
where there's texture and at an angle (the sofa, rug and kitchen: 21.0 and 20.1 dB; walls at 45°: 24.6 and 23.9).
AI depth (§4.3) adds 0.1–0.2 dB for 3 minutes more; the fill, the sharpening and trim change little there (its photos
aren't smeared and it has no layout), and the Fixer's views (§4.2) nothing.

## 3. Spots no photo saw (`fill.py`)

A flat surface's chart is a straight-on picture of it (walls, floors, ceilings, a cabinet's faces). Where the photos
covered at least 30% of such a chart but left holes of 64 texels or more, the holes (grown by a texel) and 16 texels
of their surroundings go to an inpainting model, which continues the wall's texture, the floor's planks or the
ceiling's paint into them: **LaMa** (big-lama; IOPaint's TorchScript export) on the GPU, the phone's smooth fill
(pull-push) in tests. Charts over 2048 px are filled at that size and the filled part scaled back up. Curved charts
(LiDAR furniture patches) keep the smooth fill: an image model would draw across their folds.

## 4. More stages

### 4.1 Photo cleanup (`cleanup.py`, `nafnet.py`)
Before the skins learn from them, photos the phone smeared by 1.5 px or more (at 1920 px, atrium_photoreal's estimate
from how fast the phone turned) are sharpened by **NAFNet** (MIT; its REDS deblur weights, on the GPU in tiles), and
the skins count what's left of the smear as 30% of it. With the room layout, a TV's screen (the faces inside
RoomPlan's TV box, facing along its thinnest side) says nothing in training, since it shows a different picture in
every photo, and is painted as a TV that's off; windows whose glass came out dark get a soft daylight gradient,
keeping their frames. Nothing else about the home changes.

### 4.2 The Fixer's views (`fixviews.py`)
Twice during training (at 45% and 85% of the steps), 80 views from where buyers walk (each round further from the
photos) are rendered from the skins so far, cleaned up by NVIDIA's Fixer (on a GPU of its own), tone-locked to the
render (its broad shading put back: the Fixer may tidy detail, not relight) and added to training at half a photo's
weight, a quarter of each batch. They don't count as seen for the fill. It runs only when the job's `fixerViews` is
true: on the synthetic apartment it changed nothing measurable in two GPU rounds (within 0.1 dB either way), for
2 minutes and a second GPU more.

### 4.3 Sharper depth (`depth.py`)
**Prompt Depth Anything** (ViT-L) turns the model's own depth at each photo (rendered at the LiDAR's 256×192) into
sharp depth at 960 px. Where the two disagree by more than 4 cm + 4% (grown by 2 px), the photo's pixels say nothing:
the model's shape is off there (a furniture edge, clutter the scan smoothed over) and its colors would land on the
wrong surface.

The same depth reshapes what the LiDAR scanned (`fuse.py`): for each piece the phone kept as the LiDAR's mesh
(shelves, a kitchen island, a toilet; a sofa the furniture stage left alone), the depth of up to 24 photos that see
it is fused into one surface within its box (Open3D's TSDF, 1 cm voxels), less what lies on the rest of the model
(the floor under it, the wall behind it). It replaces the scanned shape only if it explains at least 5% more of the
piece's pixels' depth (within 3 cm + 2%) than the scanned shape did. The depth is measured once, after the trim and
the furniture, and compared with the final shapes for the skins.

### 4.4 AI-made furniture (`furniture.py`, `triposg.py`)
For each movable piece in the room layout (sofas, chairs, beds and tables; never built-ins), the photos that see
its box at least half in frame and at least 12% of the photo across are ranked by how much of the scanned piece
they show (the steadier photo first). The best one that shows it whole and up to four more, looking at it from
directions at least 20° apart, are read at 960 px, and **SAM 2.1** (Hiera-L, Apache-2.0, through transformers)
cuts the piece out of each with its box as the prompt, kept within the box's outline, its holes filled (a throw on
a sofa's seat is the sofa's). Of the clearest few whole views, the one where the least of the piece is hidden
(by a coffee table, say: the model knows what stands in front of it) gives the cutout for **TripoSG** (VAST-AI,
MIT; its own GPU and image), on white with 10% around it; what's hidden in it is painted in by LaMa first, since
TripoSG would otherwise build the gap into the shape. TripoSG makes the piece's shape (about 30 s on an A10G; it
comes out upright, y up, and is cut to 30,000 triangles). That shape is turned about its up axis (four quarter turns, mirrored or not), stretched to fill the box
RoomPlan measured, and the turn whose outline best matches the cutouts wins (overlap counted only where nothing
in front hides the piece). At 60% overlap or better it replaces the scanned piece (the box's faces or the LiDAR's
shape, never the floor, a wall or a baseboard behind it), with new texels that start as the piece's color and that
the skins (§2) learn from the photos like the rest; below that, the scanned piece stays.

TripoSG runs with its marching-cubes decoder (scikit-image). Its fast decoder's mesher (diso) and its background
remover (RMBG-1.4) aren't used, since neither license is one we take on: the image puts a stub in place of diso
for TripoSG's imports, and the cutouts come from SAM. To try it on one photo:
`modal run modal_app.py::make_shape --image photo.jpg --box x0,y0,x1,y1 --out folder` (the cutout and an OBJ).

### 4.5 Trim (`trim.py`, `edit.py`)
With the room layout, every window and closed door is set 10 cm into its wall (`recessDepth`): the wall is cut
around it (keeping its painted texels), the door or window sits back showing the texels painted for it (a door cut
down to the floor) and its reveals are new surfaces. Then the skins as the phone painted them are read for trim, each
piece a slab standing out of its wall with the texels painted there on its face:

* **Baseboards**: a band 6–25 cm tall along the bottom of a wall, of one even color (all along the wall, and from
  its bottom to its top) that differs from the wall above it, in at least half the wall's columns (furniture hides
  the rest). 12 mm out of the wall; it stops at doors.
* **Crown moldings**: the same along the top, 6–20 cm, 2 cm out.
* **Casings**: a band 4–12 cm wide on both sides of a door or window and over it, of one width and color (and under
  a window, if it has an apron), 15 mm out.
* **Cabinet doors**: on the fronts of RoomPlan's storage boxes (the face away from the wall a box stands against),
  thin dark lines from top to bottom are the gaps between doors, and across a column the gaps between drawers: each
  becomes a groove 6 mm wide and 15 mm deep. A dark band along the bottom, the toe kick (6–16 cm), is set 6 cm back.

What the skins don't clearly show stays flat (a checked wall isn't a baseboard, a blurred line isn't a band). The new
surfaces (reveals, the slabs' sides, the grooves' sides) share one new atlas (xatlas, at the model's texel size) and
are learned from the photos like the rest. Scans from before build 13 have no layout: only baseboards and crown
moldings are looked for.

On the synthetic apartment (white baseboards 9 cm tall on off-white walls in five of its six rooms), trim finds one
baseboard, a true one: in the phone's painting the others differ from their walls by 0.01–0.06 (the bar is 0.07) and
shift by a few centimeters from photo to photo. Reading them from the trained skins (sharper, lined up) after
training, with a lower bar held up by how evenly the band runs along the wall, is the next step for it. Trim takes
seconds there.

### 4.6 Photo spots (`spots.py`, the viewer's `PhotoSpots.tsx`)
Where the photos were taken, buyers see the photos, as in Matterport and Zillow tours. The photos taken within 1 m
of each other (across the floor, in the order they were taken) make a spot, at the middle of where they were taken,
if it's at least 25 cm from every surface. From each spot the worker renders a cube of six 1024 px views of the
finished model and paints the photos over it: each pixel from the photos (the spot's own and up to 24 taken within
3.5 m) that saw the same point from nearly the same direction, by the angle between their line of sight and the
spot's (8° fades a photo's say by two thirds), never across something in front (the model's depth at the photo)
nor where it showed people or the depth model disagreed, fading in from each photo's border, and with each photo's
color and alignment as the skins learned them, so the photos agree with each other and with the model. Where no
photo saw the point, the model shows. Each cube is one JPEG, its faces in OpenGL's layout in a 3 × 2 grid (+x −x
+y over −y +z −z), which WebGL samples as stored (checked in Chromium).

The pictures upload before the model (storage kind `spot`), and the model lists them in its scene's extras
(`atriumSpots`: version, face size, and per spot its position, picture and photo count), so nothing else on the site
changes. The viewer, while the remastered model shows, loads the two spots nearest the camera (three at most in
memory), renders each one's distances once (a cube camera), and projects its photos onto the model from the spot
where the spot saw that surface: fully within 12 cm of a spot, fading out by 1.6 m, the two nearest blending
between. Rings on the floor mark the spots, and a click on the floor within 90 cm of one goes exactly there.

## 5. The job (`atrium_remaster/job.py`)

```
POST REMASTER_GPU_URL   Authorization: Bearer PHOTOREAL_WORKER_SECRET
{ "jobId", "callback": "https://<site>/api/remaster/jobs/<id>",
  "files": [{ "name": "cameras.json", "url": "<signed>" }, …],     the kept photos
  "model": { "url": "<the painted model (.glb)>" },
  "options": { … REMASTER_OPTIONS … } }
```

The worker downloads everything, checks that the photos land on the model (at least half their pixels: photos of
another scan don't), runs the stages and reports to the callback with the same secret:

| Event | Answer |
|---|---|
| `{ event: "progress", stage, progress, message }` (stages: `downloading`, `cleanup`, `shapes`, `furniture`, `depth`, `skins`, `fill`, `spots`, `uploading`) | the job |
| `{ event: "upload", files: [{ name: "spot-000.jpg", bytes }, …] }` (the photo spots, first) | `{ targets: [{ name, url, method, headers, assetUrl }] }` |
| `{ event: "upload", files: [{ name: "model.glb", bytes }] }` | `{ targets: [{ name, url, method, headers, assetUrl }] }` |
| `{ event: "done", modelUrl, stats }` | the job |
| `{ event: "failed", message }` | the job |

Options (all optional):

* Skins: `steps` (3000), `scale` (2), `maxTexels` (40 M), `longSide` (1920), `batch` (4), `tile` (768), `levels` (1),
  `maxMip` (4), `align` (true), `anneal` (0.1), `confidence` (0: off).
* Cleanup: `deblur` (true), `deblurMinSmear` (1.5 px), `deblurResidual` (0.3), `tvOff` (true), `windows` (true).
* Trim: `trim` (true: all of it), `recessDepth` (0.1 m), `baseboards`, `crowns`, `casings`, `cabinets` (true).
* Furniture: `furniture` (true), `furnitureMinFit` (0.6), `furnitureViews` (5), `furnitureLongSide` (960),
  `furnitureInFrame` (0.9).
* Depth: `depth` (true), `fuse` (true). Fixer views: `fixerViews` (false), `fixerRounds` (2), `fixerViewCount` (80), `fixerWidth`
  (1024), `fixerHeight` (576), `fixerWeight` (0.5), `fixerShare` (0.25), `fixerToneLock` (0.012).
* Photo spots: `spots` (true), `spotFace` (1024), `spotSpacing` (1 m), `spotLongSide` (1920).
* `fill` (true), `jpegQuality` (90).

The remastered model is a GLB like the phone's photo models: one unlit primitive per atlas (JPEG), the scan manifest
in the scene's extras, so the viewer loads it in place of the painted one.

## 6. AI models and licenses

Every model the remaster runs may be used commercially (checked October 2026; the full survey with sources is in the
session notes, summarized here):

| Use | Model | License |
|---|---|---|
| Fill (§3) | LaMa big-lama | Apache-2.0 (code; weights from its authors) |
| Ray casting, meshes, cutting walls | Open3D 0.20, xatlas, shapely, mapbox-earcut | MIT; MIT; BSD-3; ISC |
| Deblur (§4.1) | NAFNet (REDS weights) | MIT |
| Cutouts (§4.4) | SAM 2.1 (Hiera-L, through transformers) | Apache-2.0 |
| Depth (§4.3) | Prompt Depth Anything (ViT-L) | Apache-2.0 |
| Furniture shapes (§4.4) | TripoSG, with its marching-cubes decoder (scikit-image) | MIT; BSD-3 |
| Views (§4.2) | NVIDIA Fixer | NVIDIA Open Model License |

Kept out on purpose: nvdiffrast, nvdiffrec, diffoctreerast and the Inria Gaussian rasterizer (non-commercial);
TRELLIS, whose mesh step is NVIDIA's FlexiCubes (Kaolin ships it under its non-commercial license, and TRELLIS's
copy carries NVIDIA's all-rights-reserved notice); RMBG 1.4/2.0 (non-commercial background removers); diso (TripoSG's
fast mesher: stubbed out) and cubvh (provenance); FLUX.1 [dev] (non-commercial); Hunyuan3D (territory and user
limits); Depth Pro and UniDepth (research only); and GPL/AGPL mesh tools (pymeshfix, pymeshlab, igraph).

## 7. Set it up

1. **Modal**: the remaster shares the photoreal worker's secret (`atrium-photoreal`, docs/photoreal.md §5.1). Deploy:

   ```sh
   cd worker/remaster
   modal deploy modal_app.py          # REMASTER_GPU=L4 modal deploy … for a cheaper, slower GPU
   ```

   It prints the `start` endpoint's URL (`https://<workspace>--atrium-remaster-start.modal.run`).
2. **The site** (Vercel → Settings → Environment Variables), then redeploy:

   | Name | Value |
   |---|---|
   | `REMASTER_GPU_URL` | the `start` URL from the deploy |
   | `REMASTER_OPTIONS` | optional JSON the worker gets as its options, e.g. `{"steps": 3000}` |

3. **Database**: `supabase/migrations/20261014000000_remaster.sql` adds `tours.remaster_url`, the `remaster_jobs`
   table (owners read their jobs; the server writes them) and the `remastered` look. Open `/setup`, or the site adds
   it on first use when it can reach Postgres directly.

A job costs the GPU's time: the skins take a few minutes on an A10G for a room's photos; sharpening, depth and the
Fixer's views add to it (the Fixer the most, on a second GPU).

## 8. Develop and test

```sh
cd worker/remaster
python -m pytest tests -q        # CPU, 46 tests (below)
modal run modal_app.py::remaster_folder --capture <folder> --model <painted.glb> --out <folder>   # the stages on a GPU
modal run modal_app.py::make_shape --image <photo> --box x0,y0,x1,y1 --out <folder>             # SAM 2.1 + TripoSG on one piece
```

The tests need `open3d-cpu` (and, on Linux, `libegl1`, `libgl1` and `libusb-1.0-0`), `xatlas`, `shapely` and
`mapbox-earcut` next to the photoreal worker's requirements; `tests/room.py` makes the synthetic room (walls, floor,
ceiling, a cabinet, photos from inside with different exposures). They cover the model file, ray casting, the skins
(and that their coverage count and tile warps match the straightforward way), the fill, cleanup, depth and its
fusion, the shape edits, trim, furniture fitting, photo spots and the job against a stand-in site. The AI models
themselves are stand-ins there; their real runs are on Modal.

On the GPU, the photos' training views take 15 bytes a pixel; when they'd take more than 40% of its free memory
(hundreds of full-size photos), they wait in pinned memory and each step moves only its tiles (`skinViewsOn` in the
job's stats says which).

The site's flow (Remaster with AI, progress, the photo spots' and model's uploads, done, the look, the preview switch,
photos kept while a remaster uses them) was checked end to end on a production build with stand-in GPUs, and the
Supabase store against Postgres + PostgREST with row-level security. The viewer's photo spots were checked in
Chromium on a remastered synthetic room: WebGL samples the cubes as the worker lays them out, the photos show at a
spot and the skins away from it, with no shader errors.
