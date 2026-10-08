"""Assembles the comparison page: python3 tools/build_site.py <splats.spz>

site/index.html (three.js from jsDelivr, for publishing), site/local.html (local copy, for tests),
site/models/*, site/img/ref-*.jpg, site/views.json (metrics filled in by tools/evaluate.py) and
site/js/GaussianSplat.js (three's splat renderer, drawing splats the way the trainer does).
"""
import base64
import json
import math
import shutil
import sys
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent.parent
site, data = root / "site", root / "data"
spz = Path(sys.argv[1])
(site / "models").mkdir(parents=True, exist_ok=True)
(site / "img").mkdir(exist_ok=True)
shutil.copy(root / "out/painted-today.jpg.glb", site / "models/today.glb")
shutil.copy(root / "out/painted-lidar.jpg.glb", site / "models/lidar.glb")
shutil.copy(spz, site / "models/splats.spz")
# Artifacts serve text, not .glb/.spz: each model also ships as base64 text.
for name in ("today.glb", "lidar.glb", "splats.spz"):
    (site / "models" / f"{name}.txt").write_bytes(base64.b64encode((site / "models" / name).read_bytes()))
# three's GaussianSplat cuts splats off at 2σ and fades small ones (Mip-Splatting's opacity
# compensation). The splats here were trained like the reference 3DGS rasterizer: Gaussians reach
# out to 3σ and keep their opacity. Rendering them three's way costs about 0.6 dB, so the page uses a
# copy with the reference kernel. The relative imports point back at three's own modules.
gs_js = (root / "vendor/three@0.186.0/examples/jsm/objects/GaussianSplat.js").read_text()
for old, new in (
    ("from '../gpgpu/CountingSort.js'", "from 'three/addons/gpgpu/CountingSort.js'"),
    ("from '../utils/GaussianSplatUtils.js'", "from 'three/addons/utils/GaussianSplatUtils.js'"),
    ("const SPLAT_KERNEL_CUTOFF = 2;", "const SPLAT_KERNEL_CUTOFF = 3;"),
    ("\t\t- 2, - 2, 0,\n\t\t2, - 2, 0,\n\t\t2, 2, 0,\n\t\t- 2, 2, 0", "\t\t- 3, - 3, 0,\n\t\t3, - 3, 0,\n\t\t3, 3, 0,\n\t\t- 3, 3, 0"),
    ("If( r2.greaterThan( 4 ), () => {", "If( r2.greaterThan( SPLAT_KERNEL_CUTOFF * SPLAT_KERNEL_CUTOFF ), () => {"),
    ("color.a.mul( alphaScale )", "color.a"),
):
    assert gs_js.count(old) == 1, f"GaussianSplat.js changed upstream: {old!r}"
    gs_js = gs_js.replace(old, new)
(site / "js").mkdir(exist_ok=True)
(site / "js/GaussianSplat.js").write_text(gs_js)
tests = json.loads((data / "test.json").read_text())
SHORT = ["Sofa", "Living from door", "TV wall", "From kitchen", "Kitchen table", "Counter", "Glossy floor", "Hall mirror", "Hallway", "Bedroom", "Bath mirror", "Primary"]
old = {}
if (site / "views.json").exists():
    old = json.loads((site / "views.json").read_text())
views = []
for i, t in enumerate(tests):
    Image.open(data / t["file"]).convert("RGB").save(site / f"img/ref-{i:02d}.jpg", quality=90)
    prev = old.get("views", [{}] * len(tests))[i] if old else {}
    views.append({"name": t["name"], "short": SHORT[i], "transform": t["transform"], "psnr": prev.get("psnr", {"today": 0, "lidar": 0, "splat": 0}),
                  "ssim": prev.get("ssim", {"today": 0, "lidar": 0, "splat": 0})})
fy, h = tests[0]["intrinsics"][4], tests[0]["height"]
size = lambda p: f"{p.stat().st_size / 1e6:.1f} MB"
summary = old.get("summary") or {}
for k in ("today", "lidar", "splat"):
    summary.setdefault(k, {"psnr": 0, "ssim": 0})
summary["today"].update(size=size(site / "models/today.glb"), where="On the iPhone", time="About 10 seconds", cost="Free", clean="Yes")
summary["lidar"].update(size=size(site / "models/lidar.glb"), where="On the iPhone", time="About 10 seconds", cost="Free", clean="Yes")
summary["splat"].update(size=size(site / "models/splats.spz"), where="Cloud GPU", time=summary["splat"].get("time", "—"), cost="About $0.25–1 of GPU time", clean="No (needs the painted model)")
doc = {
    "fovY": 2 * math.degrees(math.atan(h / 2 / fy)),
    "files": {k: {"url": f"models/{name}.txt", "bytes": (site / "models" / name).stat().st_size, "textBytes": (site / "models" / f"{name}.txt").stat().st_size}
              for k, name in (("today", "today.glb"), ("lidar", "lidar.glb"), ("splat", "splats.spz"))},
    "views": views,
    "summary": summary,
    "notes": old.get("notes", []),
}
(site / "views.json").write_text(json.dumps(doc, indent=1))
template = (site / "template.html").read_text()
(site / "index.html").write_text(template.replace("__THREE__", "https://cdn.jsdelivr.net/npm/three@0.186.0"))
(site / "local.html").write_text(template.replace("__THREE__", "/vendor/three@0.186.0"))
print("site assembled:", ", ".join(f"{p.name} {size(p)}" for p in sorted((site / "models").iterdir())))
