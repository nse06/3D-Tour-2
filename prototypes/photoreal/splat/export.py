"""Exports trained splats as .spz (gzip, version 2), as three.js's SPZLoader reads it.

  python export.py ckpt.pt out.spz [--min-opacity 0.02] [--degree 1]
"""
import argparse
import gzip
import struct

import numpy as np
import torch

p = argparse.ArgumentParser()
p.add_argument("ckpt")
p.add_argument("out")
p.add_argument("--min-opacity", type=float, default=0.02)
p.add_argument("--degree", type=int, default=1)
a = p.parse_args()
state = torch.load(a.ckpt)
g = {k: v.numpy() for k, v in state["params"].items()}
op = 1 / (1 + np.exp(-g["opacity_logits"][:, 0]))
keep = op >= a.min_opacity
means, log_scales, quats, sh = g["means"][keep], g["log_scales"][keep], g["quats"][keep], g["sh"][keep]
op = op[keep]
n = len(means)
degree = min(a.degree, int(round(np.sqrt(sh.shape[1]))) - 1)
frac = 12
pos = np.round(means.astype(np.float64) * (1 << frac)).astype(np.int64)
pos = np.clip(pos, -(1 << 23), (1 << 23) - 1) & 0xFFFFFF
pos_bytes = np.stack([(pos >> 0) & 255, (pos >> 8) & 255, (pos >> 16) & 255], axis=-1).astype(np.uint8).reshape(n, 9)
alphas = np.clip(np.round(op * 255), 0, 255).astype(np.uint8)
colors = np.clip(np.round((sh[:, 0] * 0.15 + 0.5) * 255), 0, 255).astype(np.uint8)
scales = np.clip(np.round((log_scales + 10) * 16), 0, 255).astype(np.uint8)
q = quats / np.linalg.norm(quats, axis=1, keepdims=True)  # (w, x, y, z)
q = np.where(q[:, :1] < 0, -q, q)
rot = np.clip(np.round((q[:, 1:4] + 1) * 127.5), 0, 255).astype(np.uint8)
parts = [struct.pack("<IIIBBBB", 0x5053474E, 2, n, degree, frac, 0, 0), pos_bytes.tobytes(), alphas.tobytes(), colors.tobytes(), scales.tobytes(), rot.tobytes()]
if degree > 0:
    rest = sh[:, 1:(degree + 1) ** 2]  # (n, coefficients, rgb)
    parts.append(np.clip(np.round(rest * 128 + 128), 0, 255).astype(np.uint8).reshape(n, -1).tobytes())
raw = b"".join(parts)
data = gzip.compress(raw, compresslevel=9)
open(a.out, "wb").write(data)
print(f"{n} splats (of {len(keep)}), SH degree {degree}: {len(raw) / 1e6:.1f} MB raw, {len(data) / 1e6:.1f} MB gzip")
