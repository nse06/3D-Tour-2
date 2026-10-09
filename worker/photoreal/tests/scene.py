"""A tiny capture for tests: a checkered floor (y = 0) photographed from above, written the way the
Atrium Capture app uploads one (cameras.json with ARKit poses, seeds.ply, frames/, masks/)."""

import json
import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image

W, H, F = 64, 48, 56.0


def floor_color(x, z):
    """Soft checks, 0.5 m across, with a color ramp so every spot is told apart."""
    check = (np.floor(x / 0.5) + np.floor(z / 0.5)) % 2
    r = 0.25 + 0.5 * check
    g = 0.2 + 0.6 * np.clip(x / 3, 0, 1)
    b = 0.2 + 0.6 * np.clip(z / 3, 0, 1)
    return np.stack([r, g, b], -1)


def arkit_pose(position, yaw, pitch):
    """Camera-to-world, ARKit axes (x right, y up, looking along -z): turned `yaw` about y, tilted down by `pitch`."""
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(-pitch), math.sin(-pitch)
    turn = np.array([[cy, 0, sy, 0], [0, 1, 0, 0], [-sy, 0, cy, 0], [0, 0, 0, 1]])
    tilt = np.array([[1, 0, 0, 0], [0, cp, -sp, 0], [0, sp, cp, 0], [0, 0, 0, 1]])
    m = turn @ tilt
    m[:3, 3] = position
    return m


def render(pose, brightness=1.0):
    """What the camera sees of the floor (ARKit pinhole: x right, y up, -z forward); sky elsewhere."""
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    d_cam = np.stack([(u - W / 2) / F, -(v - H / 2) / F, -np.ones_like(u)], -1)
    d = d_cam @ pose[:3, :3].T
    o = pose[:3, 3]
    t = -o[1] / np.where(np.abs(d[..., 1]) > 1e-9, d[..., 1], -1e-9)
    hit = o + d * t[..., None]
    color = floor_color(hit[..., 0], hit[..., 2])
    color = np.where((t > 0)[..., None], color, np.array([0.6, 0.7, 0.9]))
    return np.clip(color * brightness, 0, 1)


def write(folder: Path, cameras=12, seeds_spacing=0.1, brightness_spread=0.0, people_on=()):
    folder = Path(folder)
    (folder / "frames").mkdir(parents=True, exist_ok=True)
    (folder / "masks").mkdir(exist_ok=True)
    frames = []
    for k in range(cameras):
        yaw = 2 * math.pi * k / cameras
        position = np.array([1.5 + 0.6 * math.sin(yaw), 1.4, 1.5 + 0.6 * math.cos(yaw)])
        pose = arkit_pose(position, yaw, 0.9)
        brightness = 1 + brightness_spread * math.sin(3 * k)
        image = render(pose, brightness)
        name = f"{k:06d}"
        if k in people_on:
            # Someone standing in the middle of the photo: a magenta block, masked.
            image[16:40, 26:38] = [1, 0, 1]
            mask = np.zeros((H // 4, W // 4), np.uint8)
            mask[16 // 4 : 40 // 4, 26 // 4 : 38 // 4] = 255
            Image.fromarray(mask).save(folder / "masks" / f"{name}.png")
        Image.fromarray((image * 255).round().astype(np.uint8)).save(folder / "frames" / f"{name}.png")
        frames.append({"file": f"frames/{name}.png", "width": W, "height": H, "fx": F, "fy": F, "cx": W / 2, "cy": H / 2, "pose": pose.T.reshape(-1).tolist(), "t": k})
    # Seeds over all the floor the cameras see (a little past the 3 m room).
    xs = np.arange(-1, 4, seeds_spacing) + seeds_spacing / 2
    gx, gz = np.meshgrid(xs, xs)
    xyz = np.stack([gx.ravel(), np.zeros(gx.size), gz.ravel()], 1).astype(np.float32)
    rgb = (floor_color(xyz[:, 0], xyz[:, 2]) * 255).round().astype(np.uint8)
    normals = np.tile(np.array([[0, 1, 0]], np.float32), (len(xyz), 1))
    header = (
        "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % len(xyz)
        + "".join(f"property float {n}\n" for n in ["x", "y", "z", "nx", "ny", "nz"])
        + "".join(f"property uchar {n}\n" for n in ["red", "green", "blue"])
        + "end_header\n"
    )
    body = b"".join(struct.pack("<6f3B", *p, *n, *c) for p, n, c in zip(xyz.tolist(), normals.tolist(), rgb.tolist()))
    (folder / "seeds.ply").write_bytes(header.encode() + body)
    doc = {
        "format": "atrium-photoreal/1",
        "frames": frames,
        "bounds": {"min": [0, 0, 0], "max": [3, 2.5, 3]},
        "rooms": [{"name": "Room", "floorY": 0, "ceilingY": 2.5, "polygon": [[0, 0], [3, 0], [3, 3], [0, 3]]}],
        "seeds": {"file": "seeds.ply", "count": len(xyz), "spacing": seeds_spacing},
    }
    (folder / "cameras.json").write_text(json.dumps(doc))
    return folder
