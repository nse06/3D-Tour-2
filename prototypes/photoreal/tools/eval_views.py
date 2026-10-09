"""Viewpoints for judging splats where the photos don't reach: the walkthrough's own views that no
photo matches, rendered from the real apartment by scene/render_views.mjs.

  python3 tools/eval_views.py <data-dir> <capture-dir> <views.json>

* "wall 1.2 m", "wall 0.6 m", "wall at 45°": standing 1.2 m and 0.6 m in front of each wall, looking
  straight at it, and 0.8 m from it looking along it at 45 degrees. (The walkthrough shows photoreal
  down to about 0.9 m from what is in view and the painted model closer, so 0.6 m says how far that
  could go.)
* "between": halfway between two spots the photos were taken from in the same room, looking across.
* "spots": the 12 held-out views render.mjs writes (test.json), near where photos were taken.

Eye height 1.6 m (the walkthrough's), level but for a slight tilt down. A viewpoint inside furniture,
or within 30 cm of it, is skipped. Poses as in scene/poses.mjs: ARKit camera-to-world, column-major.
<data-dir> is render.mjs's output (frames.json, gt-*.bin); <capture-dir> holds the export's
cameras.json (the rooms' outlines).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

EYE = 1.6
CLEARANCE = 0.3
FURNITURE, CLUTTER = 3, 4  # scene/apartment.js kinds


def pose(x, y, z, yaw_deg, pitch_deg):
    """scene/poses.mjs's pose(): turn about y (yaw 0 looks along −z, 90 along −x), then tilt."""
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    right, up, back = [cy, 0, -sy], [sy * sp, cp, cy * sp], [sy * cp, -sp, cy * cp]
    return [*right, 0, *up, 0, *back, 0, x, y, z, 1]


def yaw_toward(dx, dz):
    """Yaw (degrees) that looks along (dx, dz)."""
    return math.degrees(math.atan2(-dx, -dz))


def main():
    data, capture, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    rooms = json.loads((capture / "cameras.json").read_text())["rooms"]
    frames = json.loads((data / "frames.json").read_text())

    # Furniture and clutter as dense points (for clearance) and triangles (for "inside").
    tri = np.frombuffer((data / "gt-positions.bin").read_bytes(), dtype=np.float32).reshape(-1, 3, 3).astype(np.float64)
    kinds = np.frombuffer((data / "gt-kinds.bin").read_bytes(), dtype=np.uint8)
    obstacles = tri[np.isin(kinds, [FURNITURE, CLUTTER])]
    e1, e2 = obstacles[:, 1] - obstacles[:, 0], obstacles[:, 2] - obstacles[:, 0]
    area = 0.5 * np.linalg.norm(np.cross(e1, e2), axis=1)
    rng = np.random.default_rng(0)
    count = rng.poisson(area / 0.02**2) + 1
    which = np.repeat(np.arange(len(obstacles)), count)
    u, v = rng.random(len(which)), rng.random(len(which))
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    samples = obstacles[which, 0] + e1[which] * u[:, None] + e2[which] * v[:, None]
    tree = cKDTree(samples)

    def under_something(p):
        """A ray straight up from p hits furniture or clutter (Möller–Trumbore)."""
        d = np.array([0.0, 1.0, 0.0])
        h = np.cross(d, e2)
        a = np.einsum("ij,ij->i", e1, h)
        ok = np.abs(a) > 1e-12
        f = np.where(ok, 1 / np.where(ok, a, 1), 0)
        s = p - obstacles[:, 0]
        uu = f * np.einsum("ij,ij->i", s, h)
        q = np.cross(s, e1)
        vv = f * (q @ d)
        t = f * np.einsum("ij,ij->i", e2, q)
        return bool((ok & (uu >= 0) & (vv >= 0) & (uu + vv <= 1) & (t > 0)).any())

    def clear(x, z):
        p = np.array([x, EYE, z])
        return tree.query(p)[0] > CLEARANCE and not under_something(p)

    views, skipped = [], 0

    def add(kind, name, x, z, yaw, pitch=-6.0):
        nonlocal skipped
        if not clear(x, z):
            skipped += 1
            return
        views.append({"kind": kind, "name": name, "m": pose(x, EYE, z, yaw, pitch)})

    for room in rooms:
        poly = np.asarray(room["polygon"], dtype=np.float64)
        centroid = poly.mean(axis=0)
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            length = float(np.linalg.norm(b - a))
            if length < 1.0:
                continue
            d = (b - a) / length
            n = np.array([-d[1], d[0]])
            if np.dot(centroid - (a + b) / 2, n) < 0:
                n = -n
            mid = (a + b) / 2
            facing = yaw_toward(-n[0], -n[1])
            label = f"{room['name']}, wall {i + 1}"
            for dist in (1.2, 0.6):
                p = mid + n * dist
                add(f"wall {dist} m", label, p[0], p[1], facing)
            p = mid + n * 0.8
            add("wall at 45°", label, p[0], p[1], facing + 45)

    # Standing spots: where render.mjs's photos were taken from (36 per spot).
    spots: dict[int, list] = {}
    for f in frames:
        if f.get("spot", -1) >= 0:
            spots.setdefault(f["spot"], [f["room"], []])[1].append(f["transform"][12:15])
    centers = {k: (room, np.mean(ps, axis=0)) for k, (room, ps) in spots.items()}
    keys = sorted(centers)
    for i, ka in enumerate(keys):
        for kb in keys[i + 1 :]:
            (ra, pa), (rb, pb) = centers[ka], centers[kb]
            gap = float(np.hypot(pb[0] - pa[0], pb[2] - pa[2]))
            if ra != rb or not 1.0 < gap < 3.5:
                continue
            mid = (pa + pb) / 2
            across = yaw_toward(pb[0] - pa[0], pb[2] - pa[2]) + 90
            room_name = rooms[ra]["name"] if ra < len(rooms) else f"room {ra}"
            for turn in (0, 180):
                add("between", f"{room_name}, between spots {ka + 1} and {kb + 1}, {'left' if turn == 0 else 'right'}", mid[0], mid[2], across + turn, -8.0)

    if (data / "test.json").exists():
        for t in json.loads((data / "test.json").read_text()):
            views.append({"kind": "spots", "name": t["name"], "m": t["transform"]})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(views, indent=1))
    kinds_count = {k: sum(v["kind"] == k for v in views) for k in dict.fromkeys(v["kind"] for v in views)}
    print(f"{len(views)} views {kinds_count}, {skipped} skipped (in or near furniture)")


if __name__ == "__main__":
    main()
