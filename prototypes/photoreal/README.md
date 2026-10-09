# Photoreal prototype: painted model vs. Gaussian splats

Compares three ways of turning a phone scan's photos into a walkthrough, on a synthetic apartment
where every result can be checked against the exact photo it should reproduce:

* **Today (build 6)** — ScanCore paints the photos onto RoomPlan's walls, floors and furniture boxes.
* **Build 7** — the same, with furniture and clutter shaped from the LiDAR mesh.
* **Photoreal** — 3D Gaussian splats (Kerbl et al. 2023) trained on the photos, seeded from LiDAR-like points.

The apartment is Atrium's demo scan (`SyntheticApartment.swift`) rendered with three.js: same rooms,
doors and windows, but furniture in its real shape, clutter RoomPlan doesn't report, textured
materials, two mirrors, a glossy kitchen floor and views out of the windows (`scene/apartment.js`).
665 photos are taken the way a realtor scans (standing spots, three tilts, the walk between rooms) at
480 × 360; 12 eye-level views are held out for scoring.

## Results

Scored on the page's own screenshots at the 12 held-out views, against the real photo:

| | Today (build 6) | Build 7 (LiDAR shapes) | Photoreal (splats) |
|---|---|---|---|
| PSNR | 20.70 dB | 23.29 dB | **29.26 dB** |
| SSIM | 0.806 | 0.851 | **0.939** |
| Download | 0.8 MB | 3.0 MB | 9.3 MB |
| Made | on the phone, ~10 s | on the phone, ~10 s | here 2.7 h on 4 CPU cores; 15–30 min on a cloud GPU |

The splats are closer to the real photo at all 12 views. They lead most where a painted surface can't
follow the scene: views out of windows (a painted model pastes the view seen from elsewhere onto the
glass), reflections in mirrors and the glossy floor, plants and thin parts. They are softest where few
photos looked (a chair seat at the edge of a view, the side of a mirror frame), and their smallest
leads are at the two mirrors and the kitchen table. Everything here is softer than a real scan (480 × 360
photos, a CPU-sized model), so read the splats' quality as a floor.

The run: 12,000 steps, 549,227 Gaussians (485,878 above the export's opacity cut). Test PSNR with the
trainer's renderer: 25.6 at step 2,000, 27.2 at 4,000, 28.2 at 6,000, 28.6 at 8,000, 29.0 at 10,000 and
29.4 at 12,000. It was resumed once, at step 2,000, after the screen-size prune was switched off (below);
the opacity reset at step 6,000 cost 0.5 dB, which was back by step 8,000.

## Run it

Needs Node 20+, Python 3.11+ with numpy, Pillow and PyTorch (CPU is fine), a C++ compiler with OpenMP,
Chromium (set `CHROMIUM` to its path if Playwright's own isn't installed), and ScanCore's `scanproc`.

```sh
cd prototypes/photoreal
npm install                                  # playwright-core
(cd ../../ios/ScanCore && swift build -c release)
SCANPROC=../../ios/ScanCore/.build/release/scanproc
node server.mjs 8931 &                       # serves this folder and the app's three.js

node scene/render.mjs 8931 data              # photos, held-out views, the real triangles
python3 tools/prep.py data $SCANPROC         # raw photos, scan.json, LiDAR-like meshes, splat seeds
$SCANPROC paint data/scan.json out/painted-today.glb --images data/rgb --keep-frame
$SCANPROC paint data/scan.json out/painted-lidar.glb --images data/rgb --meshes data/meshes --keep-frame
python3 tools/glb_jpeg.py out/painted-today.glb out/painted-today.jpg.glb
python3 tools/glb_jpeg.py out/painted-lidar.glb out/painted-lidar.jpg.glb

python splat/gradcheck.py                    # the rasterizer's gradients vs. finite differences
python splat/train.py data runs/main --iters 12000 --max-gaussians 650000 --densify-until 0.6   # ~3 h on 4 CPU cores

mkdir -p vendor && curl -sL https://registry.npmjs.org/three/-/three-0.186.0.tgz | tar -xz -C vendor && mv vendor/package vendor/three@0.186.0
PY=python tools/final.sh runs/main          # export → page → screenshots → scores → notes
python splat/viewer_check.py runs/main/ckpt.pt data eval/page-final   # page vs. trainer, step by step
```

`tools/final.sh` runs the last steps one by one: `splat/export.py` (`.spz`), `tools/build_site.py`
(`site/index.html` with CDN three.js and `site/local.html` with the vendored copy), `tools/capture.mjs`
(a screenshot of every held-out viewpoint per method, taken from the page itself), `tools/evaluate.py`
(PSNR / SSIM against the real photos → `site/views.json`) and `tools/finalize.py` (the page's notes).
`site/` is then a static page: publish `index.html` with `views.json`, `js/`, `models/*.txt` (the models as
base64 text, for hosts that only serve text and images) and `img/`. `tools/shot.mjs` takes a full-page
screenshot for a quick look.

## Tuning the painted model on a messy capture

The clean capture flatters the painting: perfect poses, near-perfect meshes, one exposure. `tools/roughen.py`
makes a copy as rough as a real scan — ARKit-like LiDAR meshes (fused on a 2.5 cm grid, swollen 1.5 cm,
only the sides the photos faced), poses drifting about 1.5 cm and 0.3° through the scan, and auto-exposure —
and `tools/bench_paint.sh` paints a capture with `scanproc`, renders the model at the 12 held-out views
(`scene/render_model.mjs` with `scene/model.html`) and scores it (`tools/score.py`). `tools/pose_error.py`
says how far poses are from the truth in pixels, e.g. the ones the painting lined up (`--poses`).

```sh
python3 tools/roughen.py data data-rough
SCANPROC=$SCANPROC tools/bench_paint.sh data-rough lidar --meshes    # → out/bench-lidar.glb, eval/bench-lidar/, PSNR / SSIM
python3 tools/pose_error.py data/scan.json data-rough/scan.json out/bench-lidar.poses.json
```

| Capture, shapes | Build 7 | Build 8 |
|---|---|---|
| Rough, LiDAR | 21.22 dB (SSIM 0.776) | **22.00 dB** (0.796) |
| Rough, boxes | 19.76 dB | **20.16 dB** |
| Clean, LiDAR | 23.40 dB | **23.65 dB** |
| Clean, boxes | 20.72 dB | **20.95 dB** |

(Renders from `scene/model.html` with the models' PNG textures, so clean build 7 scores 23.40 here and 23.29
on the comparison page.) Taking the roughness apart (one kind at a time on the clean capture, build 7): pose drift costs 1.9 dB,
the swollen meshes 0.5 dB, exposure 0.1 dB. Build 8 lines the photos up with each other, which fixes their
drift relative to one another; drift that neighbouring photos share stays, and needs an absolute anchor
(each photo's own LiDAR depth, a capture change).

## Judging the photoreal worker away from the photos

The splats are scored above at views near where photos were taken. Buyers also walk between those spots and
up to walls, where splats trained on a real scan fell apart (smears, needles, blobs off the walls). The worker's
trainer (`worker/photoreal`) is judged there on this apartment: `tools/eval_views.py` picks 104 viewpoints no
photo matches, at eye height (1.6 m) — 1.2 m and 0.6 m in front of every wall and 0.8 m from it looking along it
at 45°, halfway between two photo spots in the same room, and the 12 held-out views — skipping any in or within
30 cm of furniture; `scene/render_views.mjs` renders the real apartment from them. `tools/eval_splats.py` trains
the rough capture's export several ways (`VARIANTS`: the trainer's own options) and scores every view (PSNR, SSIM,
LPIPS), with contact sheets of the real view next to each variant's.

```sh
cd prototypes/photoreal
tools/eval_data.sh                  # eval-data/: both captures, their exports, the views (~20 min; needs scanproc)
pip install 'modal[api-proxy-support]' && modal setup     # or MODAL_TOKEN_ID / MODAL_TOKEN_SECRET
modal run tools/eval_modal.py --capture eval-data/capture-rough --views eval-data/views --out eval-data/results
python tools/eval_splats.py eval-data/capture-rough eval-data/views /tmp/smoke --variants base,priors \
    --steps 100 --long-side 64 --seeds 3000 --eval-scale 0.15 --cpu      # the plumbing only, on a CPU
```

`eval_modal.py` trains every variant at once, an A10G each (the worker's GPU), from the Modal volume
`atrium-photoreal-eval`, and writes `results.json`, `summary.md`, the renders and `sheet-*.jpg` into `--out`.

## How the splats are trained

`splat/rasterize.cpp` is a CPU tile rasterizer (16 × 16 tiles, depth-sorted, early termination) with
a hand-written backward pass; `splat/gs.py` projects the Gaussians (EWA, 0.3 px low-pass) and shades
them with spherical harmonics in PyTorch, so autograd covers everything but the rasterizer.
`splat/train.py` seeds Gaussians on LiDAR-like surface points (discs along the surface normal, colored
from the photos), then optimizes L1 + 0.2 D-SSIM with Adam, clones and splits under-fitted Gaussians
and prunes transparent ones for the first 60% of the steps, resets opacity every 3000 steps, and trains at
half resolution for the first 30%. The paper's other pruning rule, dropping Gaussians that cover more than
40 px on screen, is off (`--screen-prune` turns it on): it is meant for large outdoor scenes, and in rooms,
where the camera stands close to walls and furniture, it deleted 45% of the Gaussians in one step and
cost 3 dB of test PSNR. `splat/export.py` writes `.spz` (version 2, gzip) for three.js's
`SPZLoader` / `GaussianSplat`; the page converts the splats' sRGB colors for three's linear pipeline.

On a cloud GPU the same method (gsplat or the reference CUDA rasterizer) trains on full-resolution
photos with millions of Gaussians in 15–30 minutes (gsplat's paper: 19 minutes for 30,000 steps on an
A100, on Mip-NeRF 360 scenes), which is about $0.25–1 at today's hourly GPU prices; the CPU run here is
a lower bound on quality.

## Drawing the splats in the page

three.js r186's `GaussianSplat` is tuned for splats trained with anti-aliasing (Mip-Splatting), not
for standard 3DGS models like these. It cuts each Gaussian off at 2σ, fades small splats (Mip-Splatting's
opacity compensation) and, through three's color management, blends them in linear light, while the
trainer blends the photos' sRGB values. `splat/viewer_check.py` imitates each difference with the
trainer's rasterizer and scores it on the held-out views. On the final model the 2σ cutoff costs
0.8 dB, the fading 0.4 dB and linear blending 1.1 dB: 2.3 dB in all (1.4 dB on the step-2000 model,
where the gap between the page and the trainer first showed). So `tools/build_site.py` writes `site/js/GaussianSplat.js`, a copy of three's file
with the reference kernel (3σ, no fading), and the page blends the splats' colors as they are: no output
color conversion, plus an identity tone map that keeps three's half-float framebuffer. The page's
splats then match the trainer's renders to 45 dB. A production viewer should do the same, or the
trainer should learn with the viewer's kernel.
