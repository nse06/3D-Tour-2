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
python splat/train.py data runs/main --iters 12000 --max-gaussians 650000 --densify-until 0.6   # ~2 h on 4 CPU cores

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
photos with millions of Gaussians in 10–20 minutes; the CPU run here is a lower bound on quality.

## Drawing the splats in the page

three.js r186's `GaussianSplat` is tuned for splats trained with anti-aliasing (Mip-Splatting), not
for standard 3DGS models like these. It cuts each Gaussian off at 2σ, fades small splats (Mip-Splatting's
opacity compensation) and, through three's color management, blends them in linear light, while the
trainer blends the photos' sRGB values. `splat/viewer_check.py` imitates each difference with the
trainer's rasterizer and scores it on the held-out views. On the step-2000 model the 2σ cutoff costs
0.83 dB, the fading 0.05 dB and linear blending 0.51 dB: 1.4 dB in all, the gap first seen between the
page and the trainer. So `tools/build_site.py` writes `site/js/GaussianSplat.js`, a copy of three's file
with the reference kernel (3σ, no fading), and the page blends the splats' colors as they are: no output
color conversion, plus an identity tone map that keeps three's half-float framebuffer. The page's
splats then match the trainer's renders to 45 dB. A production viewer should do the same, or the
trainer should learn with the viewer's kernel.
