"""Makes the synthetic capture as rough as a real one, for tuning the painted models.

  python tools/roughen.py <data-dir> <out-dir>

The clean capture has perfect camera poses, near-perfect LiDAR meshes and one exposure for every
photo, so it hides the faults real scans show. The rough copy adds what ARKit and the camera add:

* meshes/mesh-<room id>.bin  ARKit-like meshes: the real surfaces fused on a 2.5 cm grid and meshed
                             1.5 cm out, so edges are rounded and swollen, thin parts thicken and small
                             gaps close; only the sides the room's photos faced (ARKit meshes what it
                             sees, not closed shells); 4 mm of noise
* scan.json                  the photos' poses drifting slowly through the scan (about 1.5 cm and
                             0.3°, like visual-inertial tracking between corrections) plus jitter
* rgb/                       the photos with auto-exposure: each brighter or darker by about 10%,
                             with a slight white-balance shift
"""
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage import measure

data, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(11)

# ---------- camera poses: slow drift plus jitter ----------
scan = json.loads((data / "scan.json").read_text())
frames = scan["frames"]
order = sorted(range(len(frames)), key=lambda i: frames[i]["t"])
TAU, SIG_T, SIG_R = 25.0, 0.015, math.radians(0.3)  # correlation (photos), drift: m, rad
rho = math.exp(-1 / TAU)
drift = np.zeros(6)
for i in order:
    drift = rho * drift + math.sqrt(1 - rho * rho) * rng.normal(0, 1, 6) * np.array([SIG_T] * 3 + [SIG_R] * 3)
    jitter = rng.normal(0, 1, 6) * np.array([0.002] * 3 + [math.radians(0.05)] * 3)
    dt, dr = drift[:3] + jitter[:3], drift[3:] + jitter[3:]
    m = np.array(frames[i]["transform"], dtype=np.float64).reshape(4, 4).T  # column-major → rows
    angle = np.linalg.norm(dr)
    k = dr / angle if angle > 0 else np.array([1.0, 0, 0])
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    R = np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * K @ K
    m[:3, :3] = R @ m[:3, :3]
    m[:3, 3] += dt
    frames[i]["transform"] = m.T.reshape(-1).tolist()
(out / "scan.json").write_text(json.dumps(scan))
print(f"{len(frames)} poses drifted")

# ---------- photos: auto-exposure ----------
(out / "rgb").mkdir(exist_ok=True)
lin = (np.arange(256) / 255.0)
lin = np.where(lin <= 0.04045, lin / 12.92, ((lin + 0.055) / 1.055) ** 2.4)
for f in frames:
    name = Path(f["file"]).stem
    src, dst = data / "rgb" / f"{name}.rgb", out / "rgb" / f"{name}.rgb"
    if dst.exists():
        continue
    px = np.frombuffer(src.read_bytes(), dtype=np.uint8).reshape(-1, 3)
    gain = math.exp(rng.normal(0, 0.10)) * np.exp(rng.normal(0, 0.03, 3))
    c = np.clip(lin[px] * gain, 0, 1)
    c = np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
    dst.write_bytes(np.round(c * 255).astype(np.uint8).tobytes())
print("photos re-exposed")

# ---------- ARKit-like meshes ----------
pos = np.frombuffer((data / "gt-positions.bin").read_bytes(), dtype=np.float32).reshape(-1, 3, 3)
kinds = np.frombuffer((data / "gt-kinds.bin").read_bytes(), dtype=np.uint8)
KIND = dict(wall=0, floor=1, ceiling=2, furniture=3, clutter=4, outside=5, mirror=6, trim=7, glass=8)
ARCLASS = {KIND["wall"]: 1, KIND["trim"]: 1, KIND["mirror"]: 1, KIND["floor"]: 2, KIND["ceiling"]: 3}
RECTS = [((0, 5.0), (0, 4.2)), ((5.12, 8.2), (0, 4.2)), ((3.0, 8.2), (4.32, 5.52)), ((0, 2.88), (4.32, 8.0)), ((3.0, 5.4), (5.64, 8.0)), ((5.52, 8.2), (5.64, 8.6))]  # as tools/prep.py
H, ISO, MARGIN = 0.025, 0.015, 0.25
solid = ~np.isin(kinds, [KIND["outside"], KIND["glass"]])
centers = pos.mean(axis=1)
cams = np.array([np.array(f["transform"]).reshape(4, 4).T[:3, 3] for f in frames])
room_ids = [r["id"] for r in scan["rooms"]]
(out / "meshes").mkdir(exist_ok=True)

for k, ((x0, x1), (z0, z1)) in enumerate(RECTS):
    inside = solid & (centers[:, 0] > x0 - MARGIN) & (centers[:, 0] < x1 + MARGIN) & (centers[:, 2] > z0 - MARGIN) & (centers[:, 2] < z1 + MARGIN)
    tri, tk = pos[inside].astype(np.float64), kinds[inside]
    # Dense samples on the real surfaces (about 1 cm apart).
    area = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    count = rng.poisson(area * 12000) + 1
    idx = np.repeat(np.arange(len(tri)), count)
    u, v = rng.random(len(idx)), rng.random(len(idx))
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    pts = tri[idx, 0] + (tri[idx, 1] - tri[idx, 0]) * u[:, None] + (tri[idx, 2] - tri[idx, 0]) * v[:, None]
    pk = tk[idx]
    tree = cKDTree(pts)
    # Distance to the nearest surface on a grid, in a band around the samples.
    lo = pts.min(axis=0) - 3 * H
    dims = np.ceil((pts.max(axis=0) + 3 * H - lo) / H).astype(int) + 1
    occ = np.zeros(dims, dtype=bool)
    vi = np.floor((pts - lo) / H).astype(int)
    occ[vi[:, 0], vi[:, 1], vi[:, 2]] = True
    band = ndimage.binary_dilation(occ, iterations=2)
    field = np.full(dims, 3 * H, dtype=np.float32)
    bi = np.argwhere(band)
    d, _ = tree.query(lo + bi * H, workers=-1)
    field[bi[:, 0], bi[:, 1], bi[:, 2]] = d
    verts, faces, _, _ = measure.marching_cubes(field, level=ISO, spacing=(H, H, H), gradient_direction="ascent")
    verts += lo
    # Only what the room's photos faced: ARKit meshes the surfaces it sees.
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    fc = (a + b + c) / 3
    here = cams[(cams[:, 0] > x0 - MARGIN) & (cams[:, 0] < x1 + MARGIN) & (cams[:, 2] > z0 - MARGIN) & (cams[:, 2] < z1 + MARGIN)]
    seen = np.zeros(len(faces), dtype=bool)
    for start in range(0, len(here), 64):
        to = here[None, start:start + 64, :] - fc[:, None, :]  # (faces, cams, 3)
        dist = np.linalg.norm(to, axis=2)
        cos = np.einsum("fcd,fd->fc", to, fn) / np.maximum(dist, 1e-9)
        seen |= ((cos > 0.05) & (dist < 7.0)).any(axis=1)
    faces = faces[seen]
    used = np.unique(faces)
    remap = np.full(len(verts), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    verts, faces = verts[used] + rng.normal(0, 0.004, size=(len(used), 3)), remap[faces]
    # Vertex normals and ARKit's classes (from the nearest real surface).
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    vn = np.zeros_like(verts)
    for j in range(3):
        np.add.at(vn, faces[:, j], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    _, near = tree.query((a + b + c) / 3, workers=-1)
    classes = np.array([ARCLASS.get(int(x), 0) for x in pk[near]], dtype=np.uint8)
    blob = b"ATMESH01" + struct.pack("<III", len(verts), len(faces), 3)
    blob += verts.astype("<f4").tobytes() + vn.astype("<f4").tobytes() + faces.astype("<u4").tobytes() + classes.tobytes()
    (out / "meshes" / f"mesh-{room_ids[k]}.bin").write_bytes(blob)
    up = fn[:, 1] / np.maximum(np.linalg.norm(fn, axis=1), 1e-12)
    floorish = (classes == 2) & (np.abs(up) > 0.9)
    print(f"room {k}: {len(faces)} triangles, floor faces pointing up: {(up[floorish] > 0).mean() if floorish.any() else float('nan'):.2f}")
