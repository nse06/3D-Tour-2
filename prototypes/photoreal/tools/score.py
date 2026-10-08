"""Scores renders of the held-out views against the real photos (PSNR, SSIM as in tools/evaluate.py).

  python tools/score.py <data-dir> <render-dir> [<render-dir> ...]     (render dirs hold 00.png … 11.png)
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

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
    return torch.from_numpy(np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255)


data = Path(sys.argv[1])
names = [v["name"] for v in json.loads((data / "test.json").read_text())]
for d in map(Path, sys.argv[2:]):
    p_all, s_all = [], []
    for i in range(len(names)):
        ref, im = load(data / "test" / f"{i:02d}.png"), load(d / f"{i:02d}.png")
        p_all.append(10 * math.log10(1 / max(((im - ref) ** 2).mean().item(), 1e-10)))
        s_all.append(ssim(im, ref))
    print(f"{d.name:28s} PSNR {sum(p_all) / len(p_all):6.2f}  SSIM {sum(s_all) / len(s_all):.4f}   " + " ".join(f"{p:5.2f}" for p in p_all))
