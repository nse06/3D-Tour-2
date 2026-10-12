"""Judges the remastered model (worker/remaster, docs/remaster.md) on the synthetic apartment: rebuilds
the painted model from a capture several ways and scores each against the real apartment from the
evaluation viewpoints (tools/eval_views.py), next to the painted model itself.

  python tools/eval_remaster.py <capture-dir> <painted.glb> <views-dir> <out-dir>
         [--variants painted,skins,skins+fill] [--steps 3000] [--eval-scale 1] [--cpu]

The capture and the painted model must come from the same painting (tools/eval_data.sh writes
capture-rough/ and painted-rough.glb together). tools/eval_remaster_modal.py runs it on Modal, a GPU
per variant, with LaMa for the fill; here the fill is the stand-in (pull-push) unless a GPU and the
model are at hand.

Writes <out-dir>/results.json (PSNR, SSIM and LPIPS, if the lpips package is there, per view and per
kind of view), summary.md, each variant's renders (<variant>/NNN.jpg) and contact sheets (sheet-*.jpg:
the real view, then each variant).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
_root = HERE.parents[2] if len(HERE.parents) > 2 else HERE
for sub in ("worker/photoreal", "worker/remaster"):
    if (_root / sub).is_dir():
        sys.path.insert(0, str(_root / sub))
sys.path.insert(0, str(HERE))

from eval_splats import lpips_model, sheet, ssim, summarize  # noqa: E402

# Each variant: the remaster job's options (atrium_remaster/job.py), or None for the painted model as it is.
# Every stage off, then switched on one at a time (the job's options, docs/remaster.md §5).
OFF = {"fill": False, "deblur": False, "depth": False, "trim": False, "fixerViews": False}
VARIANTS: dict[str, dict | None] = {
    "painted": None,
    "skins": dict(OFF),  # skins trained on every photo, twice the texels
    "skins+fill": {**OFF, "fill": True},  # ... and the unseen spots filled
    "full": {**OFF, "fill": True, "deblur": True},  # ... and the smeared photos sharpened first
    "full-residual0": {**OFF, "fill": True, "deblur": True, "deblurResidual": 0.0},  # ... counting the sharpened photos as sharp
    "full+depth": {**OFF, "fill": True, "deblur": True, "depth": True},  # ... and photo pixels the AI's depth puts off the model's shapes left out
    "full+trim": {"fixerViews": False},  # ... and trim (baseboards, crowns; doors, windows, casings and cabinets with a layout)
    "full+fixer": {},  # ... and the Fixer's cleaned views where buyers walk: the job's defaults
    "skins-1x": {**OFF, "scale": 1.0},  # skins at the phone's texel size
    "skins-noalign": {**OFF, "align": False},  # ... without each photo's shift, turn and zoom
    "skins-long": {**OFF, "steps": 6000},  # ... twice the steps
}


def uses_fixer(variant: str) -> bool:
    """Whether a variant learns from the Fixer's views (then it needs the Fixer on a GPU)."""
    config = VARIANTS.get(variant)
    return config is not None and config.get("fixerViews", True) is not False and "fixer" in variant


def render_views(mesh, views: list[dict], views_dir: Path, eval_scale: float):
    """The mesh from every view (ray cast, as the viewer draws unlit textures), next to the truth there."""
    from atrium_photoreal.capture import opencv_camtoworld
    from atrium_remaster.views import Caster, render

    caster = Caster.of(mesh)
    for v in views:
        truth = Image.open(views_dir / v["file"]).convert("RGB")
        w, h = max(8, round(v["width"] * eval_scale)), max(8, round(v["height"] * eval_scale))
        if truth.size != (w, h):
            truth = truth.resize((w, h), Image.LANCZOS)
        sx, sy = w / v["width"], h / v["height"]
        K = np.array([[v["fx"] * sx, 0, v["cx"] * sx], [0, v["fy"] * sy, v["cy"] * sy], [0, 0, 1]])
        hits = caster.view(K, opencv_camtoworld(v["m"]), w, h)
        yield v, render(mesh, hits, background=(0.5, 0.5, 0.5)), np.asarray(truth, np.float32) / 255


def score(variant: str, mesh, config: dict | None, stats: dict, views: list[dict], views_dir: Path, eval_scale: float, net, device: str) -> dict:
    import torch

    rows, renders = [], {}
    for v, pred_np, real_np in render_views(mesh, views, views_dir, eval_scale):
        pred = torch.from_numpy(np.ascontiguousarray(pred_np)).to(device).clamp(0, 1)
        real = torch.from_numpy(real_np).to(device)
        mse = float(((pred - real) ** 2).mean())
        row = {"file": v["file"], "kind": v["kind"], "name": v["name"], "psnr": round(10 * math.log10(1 / max(mse, 1e-12)), 3), "ssim": round(ssim(pred, real), 4)}
        if net is not None:
            with torch.no_grad():
                row["lpips"] = round(float(net(pred.permute(2, 0, 1)[None] * 2 - 1, real.permute(2, 0, 1)[None] * 2 - 1)), 4)
        rows.append(row)
        buffer = io.BytesIO()
        Image.fromarray((pred_np.clip(0, 1) * 255).round().astype(np.uint8)).save(buffer, "JPEG", quality=90)
        renders[v["file"]] = buffer.getvalue()
    return {"variant": variant, "config": config, "stats": stats, "views": rows, "renders": renders}


def run_variant(capture_dir, painted_glb, views_dir, variant: str, device: str = "cuda", eval_scale: float = 1.0, overrides: dict | None = None, services=None) -> dict:
    """One variant: the remaster (or the painted model as it is), rendered and scored at every view."""
    from atrium_photoreal.capture import load
    from atrium_remaster import glb, scene
    from atrium_remaster import layout as layout_mod
    from atrium_remaster.job import Services, remaster

    capture_dir, views_dir = Path(capture_dir), Path(views_dir)
    views = json.loads((views_dir / "views.json").read_text())
    painted = scene.from_model(glb.read(Path(painted_glb).read_bytes()))
    config = VARIANTS[variant]
    started = time.time()
    if config is None:
        mesh, stats = painted, {"atlases": [a.shape[0] for a in painted.atlases]}
    else:
        options = {**config, **(overrides or {})}
        mesh, stats = remaster(painted, load(capture_dir), options, services or Services(), device, lambda stage, value, message: None, layout=layout_mod.load(capture_dir))
        # What buyers download: the model as the job writes it (JPEG atlases).
        mesh = scene.from_model(glb.read(glb.write(scene.to_model(mesh, quality=int(options.get("jpegQuality", 90))))))
        stats["modelMB"] = round(len(glb.write(scene.to_model(mesh, quality=int(options.get("jpegQuality", 90))))) / 1e6, 1)
    stats["remasterMinutes"] = round((time.time() - started) / 60, 1)
    net = lpips_model(device)
    return score(variant, mesh, config, stats, views, views_dir, eval_scale, net, device)


def write_results(out: Path, views_dir: Path, results: list[dict]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for r in results:
        folder = out / r["variant"]
        folder.mkdir(exist_ok=True)
        for f, jpeg in r["renders"].items():
            (folder / f.replace(".png", ".jpg")).write_bytes(jpeg)
    plain = [{k: v for k, v in r.items() if k != "renders"} for r in results]
    summary = summarize(results)
    (out / "results.json").write_text(json.dumps({"summary": summary, "variants": plain}, indent=1))
    kinds = list(dict.fromkeys(row["kind"] for row in results[0]["views"]))
    metrics = [m for m in ("psnr", "ssim", "lpips") if m in results[0]["views"][0]]
    lines = ["| variant | " + " | ".join(f"{k} ({len([r for r in results[0]['views'] if r['kind'] == k])})" for k in kinds) + " | MB | minutes |"]
    lines.append("|---" * (len(kinds) + 3) + "|")
    for r in results:
        cells = [" / ".join(f"{summary[r['variant']][k][m]:.2f}" if m == "psnr" else f"{summary[r['variant']][k][m]:.3f}" for m in metrics) for k in kinds]
        lines.append(f"| {r['variant']} | " + " | ".join(cells) + f" | {r['stats'].get('modelMB', '')} | {r['stats'].get('remasterMinutes', '')} |")
    text = f"Per kind of view: {' / '.join(m.upper() for m in metrics)} (higher PSNR and SSIM, lower LPIPS are better)\n\n" + "\n".join(lines) + "\n"
    (out / "summary.md").write_text(text)
    print(text)
    for kind in kinds:
        files = [row["file"] for row in results[0]["views"] if row["kind"] == kind]
        for page in range(0, len(files), 12):
            slug = kind.replace(" ", "-").replace("°", "").replace(".", "")
            sheet(out / f"sheet-{slug}-{page // 12 + 1}.jpg", views_dir, out, results, files[page : page + 12], f"{kind}, {page + 1}–{min(len(files), page + 12)}")
    if len(results) > 1:
        base = {row["file"]: row["psnr"] for row in results[0]["views"]}
        other = results[-1]
        change = sorted(other["views"], key=lambda row: -abs(row["psnr"] - base[row["file"]]))
        sheet(out / "sheet-most-changed.jpg", views_dir, out, results, [row["file"] for row in change[:12]], f"the 12 views {other['variant']} changes most from {results[0]['variant']}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("capture", type=Path)
    p.add_argument("painted", type=Path)
    p.add_argument("views", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--variants", default="painted,skins,skins+fill")
    p.add_argument("--steps", type=int, default=0, help="override the skins' steps (0: the variant's)")
    p.add_argument("--eval-scale", type=float, default=1.0)
    p.add_argument("--cpu", action="store_true")
    a = p.parse_args()
    import torch

    device = "cpu" if a.cpu or not torch.cuda.is_available() else "cuda"
    names = [n for n in a.variants.split(",") if n]
    unknown = [n for n in names if n not in VARIANTS]
    if unknown:
        raise SystemExit(f"unknown variants {unknown}; known: {list(VARIANTS)}")
    overrides = {"steps": a.steps} if a.steps else None
    results = [run_variant(a.capture, a.painted, a.views, n, device, a.eval_scale, overrides) for n in names]
    write_results(a.out, a.views, results)


if __name__ == "__main__":
    main()
