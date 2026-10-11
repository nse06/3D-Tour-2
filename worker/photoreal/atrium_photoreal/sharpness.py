"""Which photos the splats learn the details from (docs/photoreal.md §3).

A photo taken while the phone turns is smeared by about turn rate × exposure time × focal length
pixels: indoors the camera runs at its longest exposure (1/60 s), where even a slow 0.2 rad/s turn
smears 5 px across a 1920 px photo.
Trained on every photo equally, the splats average the smeared photos in and come out soft wherever
a sharp photo saw the same thing. The painted model doesn't have this problem: it takes each spot
from its sharpest photo (ScanCore's PhotoTexturing scores photos by the same turn rate × exposure).

Two ways out (TrainConfig.blur_model):

* "kernel" (the default): every photo counts, but a smeared photo is compared with the render smeared
  the same way: a line as long as its smear, in the direction that matches it best (found by trying a
  dozen once the splats have taken shape). A smeared photo then still says where things are and what
  color they are, without pulling the splats soft.
* "sample": each photo gets a say, 0–1, how close it comes to the sharpest photo of what it shows, and
  training draws photos in proportion. On the synthetic apartment (round 4) that made renders a
  little crisper but left edges seen from few sides with fewer photos to hold them: ghosting down a
  door frame.
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as F

from .capture import Camera

# ScanCore's guess when a photo has no exposure time (PhotoTexturing: 1/50 s).
DEFAULT_EXPOSURE = 0.02
# How far away what's in view is taken to be for the smear of walking (ScanCore's PhotoSharpness).
ASSUMED_DISTANCE = 1.5


def smear_px(camera: Camera, scale: float = 1.0) -> float | None:
    """How far a photo is smeared by the phone turning and moving, in pixels at `scale` times its
    size (as ScanCore's PhotoSharpness predicts it on the phone); None if the phone didn't record how
    fast it was turning."""
    if camera.turn_rate is None or not np.isfinite(camera.turn_rate):
        return None
    exposure = camera.exposure if camera.exposure is not None and 0 < camera.exposure < 1 else DEFAULT_EXPOSURE
    fx = camera.K[0, 0] * scale
    turn = max(0.0, camera.turn_rate) * exposure * fx
    walk = max(0.0, camera.speed) * exposure * fx / ASSUMED_DISTANCE if camera.speed is not None else 0.0
    return float(np.hypot(turn, walk))


def visible_seeds(cameras: list[Camera], points: np.ndarray, grid: tuple[int, int] = (64, 48), max_depth: float = 8.0) -> np.ndarray:
    """(cameras, points) booleans: which points each camera sees. In front of it, in the frame, and not
    behind nearer points: a depth buffer `grid` cells across, each cell taking the nearest depth of
    itself and its neighbors, so a wall hides what is behind it even where its seeds are sparse."""
    seen = np.zeros((len(cameras), len(points)), dtype=bool)
    homogeneous = np.c_[points, np.ones(len(points))]
    gw, gh = grid
    for i, cam in enumerate(cameras):
        p = (homogeneous @ np.linalg.inv(cam.camtoworld).T)[:, :3]
        z = p[:, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            u = cam.K[0, 0] * p[:, 0] / z + cam.K[0, 2]
            v = cam.K[1, 1] * p[:, 1] / z + cam.K[1, 2]
        idx = np.flatnonzero((z > 0.1) & (z < max_depth) & (u >= 0) & (u < cam.width) & (v >= 0) & (v < cam.height))
        if not len(idx):
            continue
        cell = (v[idx] * gh / cam.height).astype(int) * gw + (u[idx] * gw / cam.width).astype(int)
        nearest = np.full(gw * gh, np.inf)
        np.minimum.at(nearest, cell, z[idx])
        padded = np.pad(nearest.reshape(gh, gw), 1, constant_values=np.inf)
        spread = np.min([padded[dy : dy + gh, dx : dx + gw] for dy in range(3) for dx in range(3)], axis=0).ravel()
        front = spread[cell]
        seen[i, idx[z[idx] <= front + np.maximum(0.05, 0.1 * front)]] = True
    return seen


def photo_weights(
    cameras: list[Camera],
    scales: list[float],
    points: np.ndarray,
    half_px: float = 1.0,
    max_points: int = 40_000,
    seed: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """Each photo's say (0–1) and its smear in pixels at training size (`scales[i]` times its size;
    NaN where unknown).

    A photo's say is the median, over the surface points it sees, of (sharpest smear there + half_px) /
    (its smear + half_px): 1 for the sharpest photo of its surfaces, about a quarter for one smeared
    3 px more than the sharpest when half_px is 1. Without turn rates every photo keeps a full say.
    """
    smear = np.array([np.nan if (s := smear_px(c, k)) is None else s for c, k in zip(cameras, scales)], dtype=np.float64)
    if np.isnan(smear).all() or not len(points):
        return np.ones(len(cameras)), smear
    known = np.where(np.isnan(smear), np.nanmedian(smear), smear)
    rng = np.random.default_rng(seed)
    pts = points if len(points) <= max_points else points[rng.choice(len(points), max_points, replace=False)]
    seen = visible_seeds(cameras, np.asarray(pts, dtype=np.float64))
    sharpest = np.where(seen, known[:, None], np.inf).min(0)
    weights = np.ones(len(cameras))
    for i in range(len(cameras)):
        vis = seen[i]
        if vis.any():
            weights[i] = float(np.median((sharpest[vis] + half_px) / (known[i] + half_px)))
    return np.clip(weights, 0.0, 1.0), smear


def line_kernel(length: float, angle: float, device: torch.device | str | None = None) -> torch.Tensor:
    """A (k, k) kernel smearing along a line `length` px long at `angle` radians (image x right, y
    down), normalized and symmetric about its center."""
    size = int(math.ceil(length)) + 3
    size += 1 - size % 2
    c = size // 2
    t = torch.linspace(-length / 2, length / 2, max(2, int(length * 4)), dtype=torch.float32)
    x, y = c + t * math.cos(angle), c + t * math.sin(angle)
    x0, y0 = x.floor(), y.floor()
    fx, fy = x - x0, y - y0
    k = torch.zeros(size, size)
    for dx, dy, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        k.index_put_(((y0 + dy).long(), (x0 + dx).long()), w, accumulate=True)
    return (k / k.sum()).to(device)


def smear_image(image: torch.Tensor, kernel: torch.Tensor) -> torch.Tensor:
    """An (H, W, 3) image smeared by `kernel` (edges extended)."""
    k = kernel.shape[0]
    x = F.pad(image.permute(2, 0, 1)[None], (k // 2,) * 4, mode="replicate")
    return F.conv2d(x, kernel.to(image)[None, None].expand(image.shape[2], 1, k, k), groups=image.shape[2])[0].permute(1, 2, 0)


@torch.no_grad()
def find_direction(render: torch.Tensor, photo: torch.Tensor, length: float, angles: int = 12, keep: torch.Tensor | None = None) -> float:
    """The direction (radians, 0–π) a `length` px smear of `render` must have to look most like `photo`
    (both (H, W, 3); `keep`, (H, W, 1), weighs the pixels that count)."""
    best, best_angle = math.inf, 0.0
    for a in range(angles):
        angle = math.pi * a / angles
        diff = (smear_image(render, line_kernel(length, angle, render.device)) - photo).abs()
        error = float((diff * keep).sum() / keep.sum().clamp(min=1) if keep is not None else diff.mean())
        if error < best:
            best, best_angle = error, angle
    return best_angle
