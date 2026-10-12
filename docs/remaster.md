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
| Train the skins on every photo | `skins.py` (§2) | built, CPU tests on a synthetic room; GPU eval next |
| Fill spots no photo saw | `fill.py` (§3), LaMa | built (LaMa on the GPU, pull-push in tests) |
| Clean up the photos (sharpen, denoise, TV off, windows) | §4.1 | planned |
| The Fixer's cleaned views feed the skins | §4.2 | planned |
| Sharper depth from AI | §4.3 | planned |
| AI-made furniture | §4.4 | planned (needs build 13's room layout) |
| Trim, baseboards, door and window recesses | §4.5 | planned (needs build 13's room layout) |
| Photo spots (Matterport-style) | §4.6 | planned |

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
* **Per photo**: a 3×3 color matrix and offset (auto exposure and white balance; their average is held at none), and a
  small shift, turn and zoom (what lining the photos up on the phone left).
* **Smeared photos** are compared with the render smeared the same way (atrium_photoreal's motion smear, its
  direction found once the skins take shape).
* **Finer texels**: the atlases are learned at twice the phone's texel density (8 mm → 4 mm), within 40 M texels for
  the whole home (a multiple of 16 on a side, so mipmaps line up), as a pyramid of four layers that add up (broad
  corrections spread at once, fine detail follows). Each pixel reads the mipmap its footprint covers (a floor seen at
  a grazing angle doesn't alias).
* **What no photo saw** keeps the phone's colors, apart from the broad corrections around it; the coverage map goes
  on to the fill (§3).

On a synthetic room with exact ground truth (`worker/remaster/tests/room.py`: a painted atlas softened, with a
different brightness per chart and a flat patch; 16 photos with different exposures, noise and two smeared), trained
skins cut the error on new viewpoints from 0.129 to 0.074 (the truth at the phone's texel size: 0.055).

## 3. Spots no photo saw (`fill.py`)

A flat surface's chart is a straight-on picture of it (walls, floors, ceilings, a cabinet's faces). Where the photos
covered at least 30% of such a chart but left holes of 64 texels or more, the holes (grown by a texel) and 16 texels
of their surroundings go to an inpainting model, which continues the wall's texture, the floor's planks or the
ceiling's paint into them: **LaMa** (big-lama; IOPaint's TorchScript export) on the GPU, the phone's smooth fill
(pull-push) in tests. Charts over 2048 px are filled at that size and the filled part scaled back up. Curved charts
(LiDAR furniture patches) keep the smooth fill: an image model would draw across their folds.

## 4. Planned stages

### 4.1 Photo cleanup
Before the skins learn from them, the photos are sharpened (motion blur) and denoised (dim rooms) by **NAFNet** (MIT;
REDS/GoPro deblur, SIDD denoise), with **Restormer** (MIT since October 2025) to compare. A TV that's on shows a
different picture in every photo: its screen (the room layout's TV box, or **SAM 3** asked for "television screen")
is masked out of training and painted as a TV that's off. Dark or blown-out windows are evened out, not invented.

### 4.2 The Fixer's views
NVIDIA's Fixer (commercial license; already used by the photoreal AI version) cleans up renders of the remastered
model from where buyers walk; the skins also learn from those views, at a low weight, with the render's broad
shading put back (atrium_photoreal's tone lock).

### 4.3 Sharper depth
**Prompt Depth Anything** (Apache-2.0, all sizes) turns the model's own depth at each photo (rendered at the LiDAR's
192×256, like ARKit's) into sharp depth at the photo's resolution. First use: photo pixels where the model's shape
disagrees with it say nothing (no color across furniture edges). Then: a finer mesh for furniture and clutter, fused
from it (Open3D's TSDF).

### 4.4 AI-made furniture
For movable furniture (sofas, chairs, beds, tables; never built-ins), the sharpest photo's crop, cut out by **SAM
2.1** (Apache-2.0) with the furniture's box as the prompt, goes to an image-to-3D model: **TRELLIS** (MIT; the mesh
path only, which needs none of NVIDIA's non-commercial libraries) on an A10G, or **TRELLIS.2** (MIT, ≥24 GB, with
its background remover swapped for BiRefNet and nvdiffrast kept out). The shape is turned to match the photos'
silhouettes, scaled into the box RoomPlan measured, and skinned from the photos like the rest (§2).

### 4.5 Trim
From the room layout's doors and windows: doors and windows recessed into their walls with casings and sills; from
the wall skins: baseboards and crown molding where the photos show them.

### 4.6 Photo spots
At the spots where photos were taken, the real photos lined up on the model (a panorama per spot, the gaps from the
model), as Matterport and Zillow tours show them; the viewer moves between spots over the remastered model.

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
| `{ event: "progress", stage, progress, message }` (stages: `downloading`, `skins`, `fill`, `uploading`) | the job |
| `{ event: "upload", files: [{ name: "model.glb", bytes }] }` | `{ targets: [{ name, url, method, headers, assetUrl }] }` |
| `{ event: "done", modelUrl, stats }` | the job |
| `{ event: "failed", message }` | the job |

Options (all optional): `steps` (3000), `scale` (2), `maxTexels` (40 M), `longSide` (1920), `batch` (4), `tile`
(768), `levels` (4), `maxMip` (4), `fill` (true), `jpegQuality` (90).

The remastered model is a GLB like the phone's photo models: one unlit primitive per atlas (JPEG), the scan manifest
in the scene's extras, so the viewer loads it in place of the painted one.

## 6. AI models and licenses

Every model the remaster runs may be used commercially (checked October 2026; the full survey with sources is in the
session notes, summarized here):

| Use | Model | License |
|---|---|---|
| Fill (§3) | LaMa big-lama | Apache-2.0 (code; weights from its authors) |
| Ray casting, TSDF, meshes | Open3D 0.20, xatlas, fast-simplification | MIT |
| Deblur/denoise (§4.1) | NAFNet; Restormer to compare | MIT; MIT since 2025-10-23 |
| Masks (§4.1, §4.4) | SAM 2.1; SAM 3 for text prompts | Apache-2.0; SAM License (commercial use allowed) |
| Depth (§4.3) | Prompt Depth Anything; MoGe-2 | Apache-2.0; MIT |
| Furniture (§4.4) | TRELLIS (mesh path), TRELLIS.2 | MIT (DINOv3 License for TRELLIS.2's encoder) |
| Views (§4.2) | NVIDIA Fixer | NVIDIA Open Model License |

Kept out on purpose: nvdiffrast, nvdiffrec, diffoctreerast and the Inria Gaussian rasterizer (non-commercial), RMBG
1.4/2.0 (non-commercial background removers), diso, cubvh (provenance), FLUX.1 [dev] (non-commercial), Hunyuan3D
(territory and user limits), Depth Pro and UniDepth (research only), and GPL/AGPL mesh tools (pymeshfix, igraph).

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

A job costs the GPU's time: the skins take a few minutes on an A10G for a room's photos; the planned stages add to it.

## 8. Develop and test

```sh
cd worker/remaster
python -m pytest tests -q        # CPU: the model file, ray casting, skins, fill, the job against a stand-in site
modal run modal_app.py::remaster_folder --capture <folder> --model <painted.glb> --out <folder>   # on a GPU
```

The tests need `open3d-cpu` (and, on Linux, `libegl1` and `libgl1`) next to the photoreal worker's requirements;
`tests/room.py` makes the synthetic room. The site's flow (Remaster with AI, progress, upload, done, the look, the
preview switch, photos kept while a remaster uses them) was checked end to end on a production build with stand-in
GPUs, and the Supabase store against Postgres + PostgREST with row-level security.
