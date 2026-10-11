"""Which photos the splats learn the details from (docs/photoreal.md §3).

A photo taken while the phone turns is smeared by about turn rate × exposure time × focal length
pixels: indoors in the evening (1/30 s) even a slow 0.2 rad/s turn smears 9 px across a 1920 px photo.
Trained on every photo equally, the splats average the smeared photos in and come out soft wherever
a sharp photo saw the same thing. The painted model doesn't have this problem: it takes each spot
from its sharpest photo (ScanCore's PhotoTexturing scores photos by the same turn rate × exposure).

So each photo gets a say, 0–1: how close it comes to the sharpest photo of what it shows. A photo
that is the sharpest view of its surfaces keeps a full say, however smeared (nothing better saw them);
one that is much blurrier than other photos of the same surfaces hardly counts. Training draws photos
in proportion (TrainConfig.blur_power), so the details come from the sharp ones and the smeared ones
still hold the rest in place.
"""

from __future__ import annotations

import numpy as np

from .capture import Camera

# ScanCore's guess when a photo has no exposure time (PhotoTexturing: 1/50 s).
DEFAULT_EXPOSURE = 0.02


def smear_px(camera: Camera, scale: float = 1.0) -> float | None:
    """How far a photo is smeared by the phone turning, in pixels at `scale` times its size; None if
    the phone didn't record how fast it was turning."""
    if camera.turn_rate is None or not np.isfinite(camera.turn_rate):
        return None
    exposure = camera.exposure if camera.exposure is not None and 0 < camera.exposure < 1 else DEFAULT_EXPOSURE
    return float(max(0.0, camera.turn_rate) * exposure * camera.K[0, 0] * scale)


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
