"""Prepares the synthetic capture for both pipelines.

  python3 tools/prep.py <data-dir> <scanproc>

* rgb/<frame>.rgb      raw RGB copies of the photos (what `scanproc paint` reads)
* scan.json            the demo apartment's RoomPlan-style scan (local frame) with the photos as frames
* meshes/mesh-<room id>.bin   a LiDAR-like mesh per room: the real surfaces around it, 8 mm noise
* points.npz           LiDAR-like points on the real surfaces (for the Gaussian splats), with normals
"""
import json
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

data, scanproc = Path(sys.argv[1]), sys.argv[2]
rng = np.random.default_rng(7)

# Photos → raw RGB.
frames = json.loads((data / "frames.json").read_text())
(data / "rgb").mkdir(exist_ok=True)
for f in frames:
    name = Path(f["file"]).stem
    out = data / "rgb" / f"{name}.rgb"
    if not out.exists():
        out.write_bytes(np.asarray(Image.open(data / f["file"]).convert("RGB")).tobytes())
print(f"{len(frames)} photos converted")

# The scan, with the photos.
subprocess.run([scanproc, "demo-scan", str(data / "scan-base.json"), "--local"], check=True, capture_output=True)
scan = json.loads((data / "scan-base.json").read_text())
keys = ("file", "t", "transform", "intrinsics", "width", "height", "imageWidth", "imageHeight", "angularSpeed", "exposureDuration")
scan["frames"] = [{k: f[k] for k in keys} for f in frames]
(data / "scan.json").write_text(json.dumps(scan))
room_ids = [r["id"] for r in scan["rooms"]]

# The real surfaces.
pos = np.frombuffer((data / "gt-positions.bin").read_bytes(), dtype=np.float32).reshape(-1, 3, 3)
kinds = np.frombuffer((data / "gt-kinds.bin").read_bytes(), dtype=np.uint8)
rooms = np.frombuffer((data / "gt-rooms.bin").read_bytes(), dtype=np.uint8)
KIND = dict(wall=0, floor=1, ceiling=2, furniture=3, clutter=4, outside=5, mirror=6, trim=7, glass=8)
print(f"{len(kinds)} real triangles")

# LiDAR-like meshes: per room, everything solid within 25 cm of its outline (ARKit sees a bit
# past doorways), every vertex jittered by 8 mm (cracks between triangles close when ScanCore welds).
RECTS = [((0, 5.0), (0, 4.2)), ((5.12, 8.2), (0, 4.2)), ((3.0, 8.2), (4.32, 5.52)), ((0, 2.88), (4.32, 8.0)), ((3.0, 5.4), (5.64, 8.0)), ((5.52, 8.2), (5.64, 8.6))]
ARCLASS = {KIND["wall"]: 1, KIND["trim"]: 1, KIND["mirror"]: 1, KIND["floor"]: 2, KIND["ceiling"]: 3}
solid = ~np.isin(kinds, [KIND["outside"], KIND["glass"]])
centers = pos.mean(axis=1)
(data / "meshes").mkdir(exist_ok=True)
for k, ((x0, x1), (z0, z1)) in enumerate(RECTS):
    m = 0.25
    inside = solid & (centers[:, 0] > x0 - m) & (centers[:, 0] < x1 + m) & (centers[:, 2] > z0 - m) & (centers[:, 2] < z1 + m)
    tri = pos[inside] + rng.normal(0, 0.008, size=pos[inside].shape).astype(np.float32)
    n = len(tri)
    verts = tri.reshape(-1, 3)
    e1, e2 = tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    fn = np.cross(e1, e2)
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-9)
    normals = np.repeat(fn, 3, axis=0)
    classes = np.array([ARCLASS.get(int(c), 0) for c in kinds[inside]], dtype=np.uint8)
    blob = b"ATMESH01" + struct.pack("<III", len(verts), n, 3)
    blob += verts.astype("<f4").tobytes() + normals.astype("<f4").tobytes() + np.arange(len(verts), dtype="<u4").tobytes() + classes.tobytes()
    (data / "meshes" / f"mesh-{room_ids[k]}.bin").write_bytes(blob)
    print(f"room {k}: {n} mesh triangles")

# Points for the splats: area-weighted samples on every visible surface (the view out of the
# windows too), as a LiDAR scan plus the backdrop would give.
keep = kinds != KIND["glass"]
P, K = pos[keep], kinds[keep]
area = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
density = np.where(K == KIND["outside"], 120.0, 1400.0)  # points per m²
count = rng.poisson(area * density)
idx = np.repeat(np.arange(len(P)), count)
u, v = rng.random(len(idx)), rng.random(len(idx))
flip = u + v > 1
u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
pts = P[idx, 0] + (P[idx, 1] - P[idx, 0]) * u[:, None] + (P[idx, 2] - P[idx, 0]) * v[:, None]
nrm = np.cross(P[idx, 1] - P[idx, 0], P[idx, 2] - P[idx, 0])
nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
pts += rng.normal(0, 0.006, size=pts.shape)
np.savez_compressed(data / "points.npz", points=pts.astype(np.float32), normals=nrm.astype(np.float32), kinds=K[idx])
print(f"{len(pts)} splat seed points ({(K[idx] == KIND['outside']).sum()} outside)")
