"""Scores page captures against the real photos and writes the grid images and views.json metrics.

  python tools/evaluate.py <capture-dir>     (captures: today-00.png … splat-11.png)
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

root = Path(__file__).resolve().parent.parent
cap = Path(sys.argv[1])
site = root / "site"
doc = json.loads((site / "views.json").read_text())
x = torch.arange(11, dtype=torch.float32) - 5
g = torch.exp(-(x * x) / (2 * 1.5 ** 2))
g /= g.sum()
win = (g[:, None] * g[None, :]).expand(3, 1, 11, 11).contiguous()


def ssim(a, b):
    a, b = a.permute(2, 0, 1)[None], b.permute(2, 0, 1)[None]
    mu_a, mu_b = F.conv2d(a, win, padding=5, groups=3), F.conv2d(b, win, padding=5, groups=3)
    s_aa = F.conv2d(a * a, win, padding=5, groups=3) - mu_a ** 2
    s_bb = F.conv2d(b * b, win, padding=5, groups=3) - mu_b ** 2
    s_ab = F.conv2d(a * b, win, padding=5, groups=3) - mu_a * mu_b
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    return (((2 * mu_a * mu_b + c1) * (2 * s_ab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (s_aa + s_bb + c2))).mean().item()


def load(path):
    im = Image.open(path).convert("RGB")
    if im.size != (480, 360):
        im = im.crop((0, 0, 480, 360)) if im.size[0] >= 480 and im.size[1] >= 360 else im.resize((480, 360))
    return im


totals = {k: [0.0, 0.0] for k in ("today", "lidar", "splat")}
for i, v in enumerate(doc["views"]):
    ref = torch.from_numpy(np.asarray(Image.open(site / f"img/ref-{i:02d}.jpg").convert("RGB"), dtype=np.float32) / 255)
    ref_png = root / "data" / "test" / f"{i:02d}.png"
    if ref_png.exists():
        ref = torch.from_numpy(np.asarray(Image.open(ref_png).convert("RGB"), dtype=np.float32) / 255)
    for k in totals:
        im = load(cap / f"{k}-{i:02d}.png")
        im.save(site / f"img/{k}-{i:02d}.jpg", quality=88)
        t = torch.from_numpy(np.asarray(im, dtype=np.float32) / 255)
        mse = ((t - ref) ** 2).mean().item()
        p, s = 10 * math.log10(1 / max(mse, 1e-10)), ssim(t, ref)
        v["psnr"][k], v["ssim"][k] = round(p, 2), round(s, 4)
        totals[k][0] += p
        totals[k][1] += s
n = len(doc["views"])
for k, (p, s) in totals.items():
    doc["summary"][k]["psnr"] = round(p / n, 2)
    doc["summary"][k]["ssim"] = round(s / n, 4)
(site / "views.json").write_text(json.dumps(doc, indent=1))
for k in totals:
    print(f"{k:6s} PSNR {doc['summary'][k]['psnr']:.2f} dB  SSIM {doc['summary'][k]['ssim']:.3f}")
for i, v in enumerate(doc["views"]):
    print(f"  {v['short']:18s} " + "  ".join(f"{k} {v['psnr'][k]:5.2f}" for k in totals))
