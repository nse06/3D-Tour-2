"""How far photo poses are from the truth: python tools/pose_error.py <true scan.json> <scan.json or poses.json> ...

Each further argument is a scan (its frames' poses) or a list of 16-number transforms (scanproc paint
--poses). Reports position and angle errors, and what matters for painting: how far points 1.5–4 m in
front of the camera land from where they should in the photo (pixels).
"""
import json
import math
import sys

import numpy as np


def load(path):
    doc = json.load(open(path))
    items = [f["transform"] for f in doc["frames"]] if isinstance(doc, dict) else doc
    return [np.array(t, dtype=np.float64).reshape(4, 4).T for t in items]


scan = json.load(open(sys.argv[1]))
truth = load(sys.argv[1])
k = scan["frames"][0]["intrinsics"]
fx, fy, cx, cy = k[0], k[4], k[6], k[7]
w, h = scan["frames"][0]["width"], scan["frames"][0]["height"]
# Points on a grid across the image, at several depths, in camera space (x right, y up, looking along −z).
us, vs, ds = np.meshgrid(np.linspace(0.1, 0.9, 7) * w, np.linspace(0.1, 0.9, 5) * h, [1.5, 2.5, 4.0])
us, vs, ds = us.ravel(), vs.ravel(), ds.ravel()
cam_pts = np.stack([(us - cx) / fx * ds, -(vs - cy) / fy * ds, -ds, np.ones_like(ds)])
for path in sys.argv[2:]:
    shift, turn, pixels = [], [], []
    for a, b in zip(truth, load(path)):
        shift.append(np.linalg.norm(a[:3, 3] - b[:3, 3]))
        r = a[:3, :3].T @ b[:3, :3]
        turn.append(math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(r) - 1) / 2)))))
        world = a @ cam_pts
        local = np.linalg.inv(b) @ world
        z = -local[2]
        u2, v2 = fx * local[0] / z + cx, -fy * local[1] / z + cy
        pixels.append(np.hypot(u2 - us, v2 - vs).mean())
    shift, turn, pixels = np.array(shift) * 100, np.array(turn), np.array(pixels)
    print(f"{path:40s} position {shift.mean():.2f} cm   angle {turn.mean():.3f}°   in the photo {pixels.mean():.2f} px of {w} (median {np.median(pixels):.2f}, 90% {np.percentile(pixels, 90):.2f})")
