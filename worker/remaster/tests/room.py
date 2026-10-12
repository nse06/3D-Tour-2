"""A small room for tests, made the way the phone makes one, from a ground truth the tests compare with:

* model.glb: the painted model (walls, floor, ceiling and a cabinet, each flat face a chart of one
  atlas), its atlas a softened copy of the truth with a different brightness per chart and a patch no
  photo saw, as painting leaves them;
* cameras.json, seeds.ply, frames/: the photos (atrium-photoreal/1, ARKit poses), taken from inside the
  room with different exposures, a little noise, and some smeared by the phone turning.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from atrium_photoreal.enhance import look
from atrium_remaster import glb, views
from atrium_remaster.scene import Mesh, encode

SIZE = (3.0, 2.5, 3.0)  # x, height, z
TEXEL = 0.02
ATLAS = 512
PAD = 2
W, H, F = 160, 120, 120.0
EXPOSURE = 1 / 60
SEED_SPACING = 0.05


@dataclass
class Chart:
    name: str
    origin: np.ndarray
    u: np.ndarray  # unit, along the chart's width
    v: np.ndarray  # unit, along its height (atlas rows go down v)
    width: float
    height: float
    hue: tuple[float, float, float]
    rect: tuple[int, int, int, int] = (0, 0, 0, 0)  # x, y, w, h in texels, padding included


def charts() -> list[Chart]:
    X, Y, Z = SIZE
    e = np.eye(3)
    cab = (0.8, 0.9, 0.5)  # a cabinet against the far wall (z = 0), from x = 1.0
    cx0, cx1, cz1 = 1.0, 1.0 + cab[0], cab[2]
    return [
        Chart("floor", np.array([0, 0, 0.0]), e[0], e[2], X, Z, (0.55, 0.42, 0.30)),
        Chart("ceiling", np.array([0, Y, Z]), e[0], -e[2], X, Z, (0.85, 0.85, 0.82)),
        Chart("wall_z0", np.array([0, Y, 0.0]), e[0], -e[1], X, Y, (0.75, 0.70, 0.62)),
        Chart("wall_x3", np.array([X, Y, 0.0]), e[2], -e[1], Z, Y, (0.62, 0.70, 0.75)),
        Chart("wall_z3", np.array([X, Y, Z]), -e[0], -e[1], X, Y, (0.70, 0.75, 0.62)),
        Chart("wall_x0", np.array([0, Y, Z]), -e[2], -e[1], Z, Y, (0.75, 0.62, 0.70)),
        Chart("cab_front", np.array([cx0, cab[1], cz1]), e[0], -e[1], cab[0], cab[1], (0.35, 0.45, 0.60)),
        Chart("cab_top", np.array([cx0, cab[1], 0.0]), e[0], e[2], cab[0], cab[2], (0.60, 0.35, 0.40)),
        Chart("cab_left", np.array([cx0, cab[1], 0.0]), e[2], -e[1], cab[2], cab[1], (0.40, 0.60, 0.35)),
        Chart("cab_right", np.array([cx1, cab[1], cz1]), -e[2], -e[1], cab[2], cab[1], (0.45, 0.40, 0.65)),
    ]


def pattern(chart: Chart, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """The truth on a chart at (a, b) meters along (u, v): its own color, 20 cm checks, and thin lines
    every 30 cm (detail a soft skin loses)."""
    check = (np.floor(a / 0.2) + np.floor(b / 0.2)) % 2
    line = (np.abs(((a + 0.07) % 0.3) - 0.15) < 0.012) | (np.abs(((b + 0.11) % 0.3) - 0.15) < 0.012)
    base = np.asarray(chart.hue)
    color = base * (0.75 + 0.35 * check[..., None])
    color = np.where(line[..., None], 0.15, color)
    return np.clip(color, 0, 1)


def pack(items: list[Chart]) -> None:
    x = y = row = 0
    for c in items:
        w = int(math.ceil(c.width / TEXEL)) + 2 * PAD
        h = int(math.ceil(c.height / TEXEL)) + 2 * PAD
        if x + w > ATLAS:
            x, y, row = 0, y + row, 0
        c.rect = (x, y, w, h)
        x += w
        row = max(row, h)
        if y + h > ATLAS:
            raise ValueError("room atlas overflow")


def truth_atlas(items: list[Chart]) -> np.ndarray:
    atlas = np.full((ATLAS, ATLAS, 3), 0.5, np.float32)
    for c in items:
        x0, y0, w, h = c.rect
        ii, jj = np.meshgrid(np.arange(w), np.arange(h))
        a = (ii + 0.5 - PAD) * TEXEL
        b = (jj + 0.5 - PAD) * TEXEL
        atlas[y0 : y0 + h, x0 : x0 + w] = pattern(c, a, b)
    return atlas


def build_mesh(items: list[Chart], atlas: np.ndarray) -> Mesh:
    vertices, uvs, faces = [], [], []
    for c in items:
        x0, y0, _, _ = c.rect
        corners = [(0, 0), (c.width, 0), (c.width, c.height), (0, c.height)]
        base = len(vertices)
        for a, b in corners:
            vertices.append(c.origin + a * c.u + b * c.v)
            uvs.append(((x0 + PAD + a / TEXEL) / ATLAS, (y0 + PAD + b / TEXEL) / ATLAS))
        # Front faces wind counter-clockwise seen from the room: u × v points away from it (v runs
        # down or away from the viewer), so the winding goes 0-3-2, 0-2-1.
        faces += [(base, base + 3, base + 2), (base, base + 2, base + 1)]
    return Mesh(
        vertices=np.asarray(vertices, np.float32),
        uvs=np.asarray(uvs, np.float32),
        faces=np.asarray(faces, np.int64),
        face_atlas=np.zeros(len(faces), np.int64),
        face_color=np.full((len(faces), 3), 0.5, np.float32),
        atlases=[atlas],
        extras={"atrium": {"schema": "atrium.scan-manifest/v1", "rooms": []}},
    )


def truth_color(items: list[Chart], mesh: Mesh, hits: views.Hits) -> np.ndarray:
    """The truth seen in a view, evaluated exactly at every hit (sharper than any atlas)."""
    points = views.surface_points(mesh, hits)
    out = np.zeros((*hits.shape, 3), np.float32)
    chart_of_face = np.repeat(np.arange(len(items)), 2)
    face = np.where(hits.hit, hits.face, 0)
    for k, c in enumerate(items):
        sel = hits.hit & (chart_of_face[face] == k)
        if sel.any():
            d = points[sel] - c.origin
            out[sel] = pattern(c, d @ c.u, d @ c.v)
    return out


def camera_poses(count: int) -> list[np.ndarray]:
    """OpenCV camera-to-world poses around the middle of the room, at eye height, looking around."""
    poses = []
    for k in range(count):
        yaw = 2 * math.pi * k / count
        position = np.array([1.5 + 0.5 * math.sin(3.1 * k), 1.5 + 0.05 * math.cos(k), 1.7 + 0.4 * math.cos(2.3 * k)])
        poses.append(look(position, yaw, -0.25 + 0.2 * math.sin(1.7 * k)))
    return poses


def seen_from(caster: views.Caster, point: np.ndarray, normal: np.ndarray, pose: np.ndarray, K: np.ndarray) -> bool:
    """Whether a camera (OpenCV pose) sees `point`: in its frame, facing it within 78 degrees, and
    nothing in between."""
    center = pose[:3, 3]
    local = pose[:3, :3].T @ (point - center)
    if local[2] <= 0.05:
        return False
    u, v = K[0, 0] * local[0] / local[2] + K[0, 2], K[1, 1] * local[1] / local[2] + K[1, 2]
    if not (0 <= u < W and 0 <= v < H):
        return False
    d = point - center
    dist = float(np.linalg.norm(d))
    if float(-(d / dist) @ normal) < math.cos(math.radians(78)):
        return False
    t, _, _ = caster.rays(center[None], (d / dist)[None])
    return bool(t[0] > dist - 0.01)


def smear_horizontally(image: np.ndarray, length: int) -> np.ndarray:
    if length <= 1:
        return image
    kernel = np.ones(length) / length
    pad = length // 2
    padded = np.pad(image, ((0, 0), (pad, length - 1 - pad), (0, 0)), mode="edge")
    out = np.zeros_like(image)
    for i in range(length):
        out += kernel[i] * padded[:, i : i + image.shape[1]]
    return out


def write(folder: Path, cameras: int = 16, smeared=(3, 8), smear_px: int = 5, brightness_spread: float = 0.15, noise: float = 0.01, seed: int = 0) -> dict:
    """Writes the room into `folder` (capture/ and model.glb) and returns the truth: the charts, the
    truth atlas and the mesh."""
    folder = Path(folder)
    capture = folder / "capture"
    (capture / "frames").mkdir(parents=True, exist_ok=True)
    items = charts()
    pack(items)
    truth = truth_atlas(items)
    mesh = build_mesh(items, truth)
    rng = np.random.default_rng(seed)

    caster = views.Caster.of(mesh)
    K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])
    frames = []
    for k, pose in enumerate(camera_poses(cameras)):
        hits = caster.view(K, pose, W, H)
        image = truth_color(items, mesh, hits)
        turn = 0.0
        if k in smeared:
            image = smear_horizontally(image, smear_px)
            turn = smear_px / (EXPOSURE * F)
        gain = 1 + brightness_spread * math.sin(3 * k)
        image = np.clip(image * gain + rng.normal(0, noise, image.shape), 0, 1)
        name = f"{k:06d}"
        Image.fromarray((image * 255 + 0.5).astype(np.uint8)).save(capture / "frames" / f"{name}.png")
        arkit = pose @ np.diag([1.0, -1.0, -1.0, 1.0])
        frames.append(
            {
                "file": f"frames/{name}.png",
                "width": W,
                "height": H,
                "fx": F,
                "fy": F,
                "cx": W / 2,
                "cy": H / 2,
                "pose": arkit.T.reshape(-1).tolist(),
                "t": float(k),
                "turnRate": turn,
                "exposure": EXPOSURE,
                "speed": 0.0,
            }
        )

    # Seeds: like the phone's, a point every 5 cm where a photo sees the surface (within 78 degrees of
    # head-on), none elsewhere (the fill takes the rest as unseen).
    seeds = []
    poses = camera_poses(cameras)
    for c in items:
        normal = -np.cross(c.u, c.v)
        for a in np.arange(0.025, c.width, SEED_SPACING):
            for b in np.arange(0.025, c.height, SEED_SPACING):
                point = c.origin + a * c.u + b * c.v
                if any(seen_from(caster, point, normal, pose, K) for pose in poses):
                    seeds.append((*point, *normal, 128, 128, 128))
    header = (
        f"ply\nformat binary_little_endian 1.0\nelement vertex {len(seeds)}\n"
        + "".join(f"property float {n}\n" for n in ["x", "y", "z", "nx", "ny", "nz"])
        + "".join(f"property uchar {n}\n" for n in ["red", "green", "blue"])
        + "end_header\n"
    )
    (capture / "seeds.ply").write_bytes(header.encode() + b"".join(struct.pack("<6f3B", *s) for s in seeds))
    X, Y, Z = SIZE
    doc = {
        "format": "atrium-photoreal/1",
        "frames": frames,
        "bounds": {"min": [0, 0, 0], "max": [X, Y, Z]},
        "rooms": [{"name": "Room", "floorY": 0.0, "ceilingY": Y, "polygon": [[0, 0], [X, 0], [X, Z], [0, Z]]}],
        "seeds": {"file": "seeds.ply", "count": len(seeds), "spacing": SEED_SPACING},
    }
    (capture / "cameras.json").write_text(json.dumps(doc))

    # The painted model: the truth softened, each chart a little brighter or darker, and a patch of a
    # wall painted one flat color (as where the phone found no photo it trusted).
    painted = np.asarray(Image.fromarray((truth * 255 + 0.5).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
    for k, c in enumerate(items):
        x0, y0, w, h = c.rect
        painted[y0 : y0 + h, x0 : x0 + w] *= 1 + 0.08 * math.sin(2.0 * k + 1)
    wall = items[3]
    wx0, wy0, _, _ = wall.rect
    patch = (slice(wy0 + PAD + 40, wy0 + PAD + 70), slice(wx0 + PAD + 50, wx0 + PAD + 90))
    painted[patch] = painted[patch].reshape(-1, 3).mean(0)
    painted = np.clip(painted, 0, 1)
    painted_mesh = Mesh(mesh.vertices, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, [painted], mesh.extras)
    from atrium_remaster.scene import to_model

    model = to_model(painted_mesh, quality=95)
    (folder / "model.glb").write_bytes(glb.write(model))
    return {"charts": items, "truth": truth, "mesh": mesh, "painted": painted, "K": K, "flat_patch": patch, "folder": folder}
