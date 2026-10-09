"""Judges the photoreal trainer where buyers walk but no photo was taken: trains splats on a capture
with the worker's own trainer (worker/photoreal), several ways, and scores each against the real
apartment from the evaluation viewpoints (tools/eval_views.py, scene/render_views.mjs).

  python tools/eval_splats.py <capture-dir> <views-dir> <out-dir> [--variants base,priors]
         [--steps 30000] [--long-side 1440] [--seeds N] [--eval-scale 1] [--cpu]

The first variant listed is the reference the "most changed" sheet compares the last one with.

On a GPU that is a real run (minutes per variant). On a CPU only a tiny one, to check the plumbing:
--steps 100 --long-side 64 --seeds 3000 --eval-scale 0.15. tools/eval_modal.py runs it on Modal, a
GPU per variant.

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
from PIL import Image, ImageDraw

# The worker's package, from this repository (on Modal it is installed next to this file). Training
# and scoring import it, and PyTorch, when they run: writing results needs neither.
_repo = Path(__file__).resolve().parents
if len(_repo) > 3 and (_repo[3] / "worker" / "photoreal" / "atrium_photoreal").is_dir():
    sys.path.insert(0, str(_repo[3] / "worker" / "photoreal"))

OFF = {"shell_snap": 0.0, "max_anisotropy": 0.0, "floater_radius": 0.0}
# Each variant: TrainConfig fields that differ from the trainer's defaults.
VARIANTS = {
    "first": {**OFF, "exposure_model": "matrix", "normalize": False},  # the trainer as first deployed
    "base": OFF,  # ... with its exposure correction anchored and MCMC sized to the capture
    "base-matrix": {**OFF, "exposure_model": "matrix"},  # ... the size fix only
    "base-meters": {**OFF, "normalize": False},  # ... the exposure fix only
    "shell": {**OFF, "shell_snap": 0.025},  # splats on walls, floors and ceilings kept flat
    "shell+aniso": {"floater_radius": 0.0},  # ... and no needles
    "priors": {},  # ... and floaters in front of the cameras cleared: the defaults
    "priors-aniso3": {"max_anisotropy": 3.0},
    "priors-sh1": {"sh_degree": 1},  # less view-dependent color to overfit with
    "priors-500k": {"max_gaussians": 500_000},
}


def ssim(a, b) -> float:
    """SSIM of two (H, W, 3) image tensors in [0, 1] (11-pixel Gaussian window, as tools/score.py)."""
    import torch
    import torch.nn.functional as F

    x = torch.arange(11, dtype=a.dtype, device=a.device) - 5
    g = torch.exp(-(x * x) / (2 * 1.5**2))
    g = g / g.sum()
    win = (g[:, None] * g[None, :]).expand(3, 1, 11, 11).contiguous()
    a, b = a.permute(2, 0, 1)[None], b.permute(2, 0, 1)[None]
    mu_a, mu_b = F.conv2d(a, win, padding=5, groups=3), F.conv2d(b, win, padding=5, groups=3)
    s_aa = F.conv2d(a * a, win, padding=5, groups=3) - mu_a**2
    s_bb = F.conv2d(b * b, win, padding=5, groups=3) - mu_b**2
    s_ab = F.conv2d(a * b, win, padding=5, groups=3) - mu_a * mu_b
    c1, c2 = 0.01**2, 0.03**2
    return float((((2 * mu_a * mu_b + c1) * (2 * s_ab + c2)) / ((mu_a**2 + mu_b**2 + c1) * (s_aa + s_bb + c2))).mean())


def lpips_model(device):
    try:
        import lpips

        return lpips.LPIPS(net="alex", verbose=False).to(device).eval()
    except Exception as e:  # not installed, or no network for its weights
        print(f"LPIPS unavailable ({type(e).__name__}: {e}); scoring PSNR and SSIM only")
        return None


def run_variant(capture_dir, views_dir, variant: str, steps: int, long_side: int, device: str, seeds: int = 0, eval_scale: float = 1.0, log=print) -> dict:
    """Trains one variant and scores it on every view: {variant, config, stats, views: [...], renders: {file: jpeg}}."""
    import torch

    from atrium_photoreal.capture import load, opencv_camtoworld
    from atrium_photoreal.render import rasterize
    from atrium_photoreal.train import TrainConfig, train

    capture_dir, views_dir = Path(capture_dir), Path(views_dir)
    overrides = VARIANTS[variant]
    capture = load(capture_dir)
    if seeds and seeds < len(capture.seeds_xyz):
        total = len(capture.seeds_xyz)
        pick = np.random.default_rng(0).choice(total, seeds, replace=False)
        capture.seeds_xyz, capture.seeds_normal, capture.seeds_rgb = capture.seeds_xyz[pick], capture.seeds_normal[pick], capture.seeds_rgb[pick]
        capture.seed_spacing *= float(np.sqrt(total / len(pick)))
    cfg = TrainConfig(steps=steps, long_side=long_side, holdout_every=0, progress_every=max(1, steps // 10), **overrides)
    started = time.time()
    result = train(capture, cfg, device=device, log=lambda m: log(f"[{variant}] {m}"), progress=lambda v, m: log(f"[{variant}] {v:6.1%} {m}"))
    splats = {k: v.to(device) for k, v in result.splats.items()}
    net = lpips_model(device)

    views = json.loads((views_dir / "views.json").read_text())
    rows, renders = [], {}
    for v in views:
        truth = Image.open(views_dir / v["file"]).convert("RGB")
        w, h = max(8, round(v["width"] * eval_scale)), max(8, round(v["height"] * eval_scale))
        if truth.size != (w, h):
            truth = truth.resize((w, h), Image.LANCZOS)
        sx, sy = w / v["width"], h / v["height"]
        K = torch.tensor([[v["fx"] * sx, 0, v["cx"] * sx], [0, v["fy"] * sy, v["cy"] * sy], [0, 0, 1]], dtype=torch.float32, device=device)
        c2w = torch.tensor(opencv_camtoworld(v["m"]), dtype=torch.float32, device=device)
        with torch.no_grad():
            image, _, _ = rasterize(splats, torch.linalg.inv(c2w), K, w, h, result.sh_degree)
            pred = image[0].clamp(0, 1)
            real = torch.from_numpy(np.array(truth)).to(device).float() / 255
            mse = float(((pred - real) ** 2).mean())
            row = {"file": v["file"], "kind": v["kind"], "name": v["name"], "psnr": round(10 * math.log10(1 / max(mse, 1e-12)), 3), "ssim": round(ssim(pred, real), 4)}
            if net is not None:
                row["lpips"] = round(float(net(pred.permute(2, 0, 1)[None] * 2 - 1, real.permute(2, 0, 1)[None] * 2 - 1)), 4)
        rows.append(row)
        buffer = io.BytesIO()
        Image.fromarray((pred.cpu().numpy() * 255).round().astype(np.uint8)).save(buffer, "JPEG", quality=90)
        renders[v["file"]] = buffer.getvalue()
    config = {k: getattr(cfg, k) for k in ("steps", "long_side", "max_gaussians", "sh_degree", "shell_snap", "shell_thickness", "max_anisotropy", "floater_radius")}
    return {"variant": variant, "config": config, "stats": {**result.stats, "evalMinutes": round((time.time() - started) / 60, 1)}, "views": rows, "renders": renders}


def summarize(results: list[dict]) -> dict:
    """Mean of each metric per kind of view, per variant."""
    out = {}
    for r in results:
        kinds = {}
        for row in r["views"]:
            kinds.setdefault(row["kind"], []).append(row)
        out[r["variant"]] = {
            kind: {m: round(float(np.mean([row[m] for row in rows])), 4 if m != "psnr" else 2) for m in ("psnr", "ssim", "lpips") if m in rows[0]} | {"views": len(rows)}
            for kind, rows in kinds.items()
        }
    return out


def sheet(path: Path, views_dir: Path, out: Path, results: list[dict], files: list[str], title: str, cell=(240, 180)):
    """Rows of views: the real one, then each variant's render with its PSNR."""
    cw, ch = cell
    by_variant = {r["variant"]: {row["file"]: row for row in r["views"]} for r in results}
    cols = 1 + len(results)
    canvas = Image.new("RGB", (cols * cw, 32 + len(files) * (ch + 16)), "white")
    draw = ImageDraw.Draw(canvas)
    draw.text((4, 2), title, fill="black")
    for c, name in enumerate(["real", *[r["variant"] for r in results]]):
        draw.text((c * cw + 4, 17), name, fill="black")
    for i, f in enumerate(files):
        y = 32 + i * (ch + 16)
        first = next(iter(by_variant.values()))[f]
        draw.text((4, y + 2), f"{first['kind']}: {first['name']}"[:60], fill="black")
        canvas.paste(Image.open(views_dir / f).convert("RGB").resize(cell), (0, y + 16))
        for c, r in enumerate(results, start=1):
            canvas.paste(Image.open(out / r["variant"] / f.replace(".png", ".jpg")).convert("RGB").resize(cell), (c * cw, y + 16))
            draw.rectangle((c * cw, y + 16, c * cw + 52, y + 29), fill="black")
            draw.text((c * cw + 3, y + 17), f"{by_variant[r['variant']][f]['psnr']:.1f} dB", fill="white")
    canvas.save(path, quality=85)


def write_results(out: Path, views_dir: Path, results: list[dict]):
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
    lines = ["| variant | " + " | ".join(f"{k} ({len([r for r in results[0]['views'] if r['kind'] == k])})" for k in kinds) + " | splats | minutes |"]
    lines.append("|---" * (len(kinds) + 3) + "|")
    for r in results:
        cells = [" / ".join(f"{summary[r['variant']][k][m]:.2f}" if m == "psnr" else f"{summary[r['variant']][k][m]:.3f}" for m in metrics) for k in kinds]
        lines.append(f"| {r['variant']} | " + " | ".join(cells) + f" | {r['stats']['gaussians']:,} | {r['stats'].get('evalMinutes', '')} |")
    text = f"Per kind of view: {' / '.join(m.upper() for m in metrics)} (higher PSNR and SSIM, lower LPIPS are better)\n\n" + "\n".join(lines) + "\n"
    (out / "summary.md").write_text(text)
    print(text)

    names = [r["variant"] for r in results]
    for kind in kinds:
        files = [row["file"] for row in results[0]["views"] if row["kind"] == kind]
        for page in range(0, len(files), 12):
            slug = kind.replace(" ", "-").replace("°", "").replace(".", "")
            sheet(out / f"sheet-{slug}-{page // 12 + 1}.jpg", views_dir, out, results, files[page : page + 12], f"{kind}, {page + 1}–{min(len(files), page + 12)}")
    if len(names) > 1:
        # The first variant is the reference; the views the last one changes most.
        base = {row["file"]: row["psnr"] for row in results[0]["views"]}
        other = results[-1]
        change = sorted(other["views"], key=lambda row: -abs(row["psnr"] - base[row["file"]]))
        sheet(out / "sheet-most-changed.jpg", views_dir, out, results, [row["file"] for row in change[:12]], f"the 12 views {other['variant']} changes most from {names[0]}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("capture", type=Path)
    p.add_argument("views", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--variants", default="base,priors")
    p.add_argument("--steps", type=int, default=30_000)
    p.add_argument("--long-side", type=int, default=1440)
    p.add_argument("--seeds", type=int, default=0)
    p.add_argument("--eval-scale", type=float, default=1.0)
    p.add_argument("--cpu", action="store_true")
    a = p.parse_args()
    import torch

    device = "cpu" if a.cpu or not torch.cuda.is_available() else "cuda"
    names = [n for n in a.variants.split(",") if n]
    unknown = [n for n in names if n not in VARIANTS]
    if unknown:
        raise SystemExit(f"unknown variants {unknown}; known: {list(VARIANTS)}")
    results = [run_variant(a.capture, a.views, n, a.steps, a.long_side, device, a.seeds, a.eval_scale) for n in names]
    write_results(a.out, a.views, results)


if __name__ == "__main__":
    main()
