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
python splat/train.py data runs/main --iters 12000 --max-gaussians 650000   # ~3 h on 4 CPU cores
python splat/export.py runs/main/ckpt.pt out/splats.spz

mkdir -p vendor && curl -sL https://registry.npmjs.org/three/-/three-0.186.0.tgz | tar -xz -C vendor && mv vendor/package vendor/three@0.186.0
python3 tools/build_site.py out/splats.spz   # site/index.html (CDN three.js) and site/local.html
node tools/capture.mjs 8931 eval/page        # screenshots of every viewpoint, per method
python tools/evaluate.py eval/page           # PSNR / SSIM against the real photos → site/views.json
```

`site/` is then a static page (publish `index.html` with `views.json`, `models/` and `img/`).

## How the splats are trained

`splat/rasterize.cpp` is a CPU tile rasterizer (16 × 16 tiles, depth-sorted, early termination) with
a hand-written backward pass; `splat/gs.py` projects the Gaussians (EWA, 0.3 px low-pass) and shades
them with spherical harmonics in PyTorch, so autograd covers everything but the rasterizer.
`splat/train.py` seeds Gaussians on LiDAR-like surface points (discs along the surface normal, colored
from the photos), then optimizes L1 + 0.2 D-SSIM with Adam, clones and splits under-fitted Gaussians
and prunes transparent ones until halfway, resets opacity every 3000 steps, and trains at half
resolution for the first 30%. `splat/export.py` writes `.spz` (version 2, gzip) for three.js's
`SPZLoader` / `GaussianSplat`; the page converts the splats' sRGB colors for three's linear pipeline.

On a cloud GPU the same method (gsplat or the reference CUDA rasterizer) trains on full-resolution
photos with millions of Gaussians in 10–20 minutes; the CPU run here is a lower bound on quality.
