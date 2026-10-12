"""The AI-enhanced version of the splats (docs/photoreal.md §3.1).

The photos say what the home looks like from where they were taken. Between and around those spots the
splats have to guess, and the guesses show as haze, smears, floaters and holes. A diffusion model
trained to clean up renders of 3D reconstructions (NVIDIA's Fixer, the commercially licensed successor
of Difix3D+) looks at the splats from where buyers walk and cleans each view up; the splats then keep
training on those cleaned views next to the photos. That goes in rounds, each round's views a little
further from the photos than the last (Difix3D+'s progressive distillation, Wu et al., CVPR 2025), so
each clean-up only has a little to fix. The faithful version is the splats before any of this.

The cleaned views make things up where the photos say nothing: the AI version can tidy a corner that
wasn't tidy or invent a little texture. That's why both versions are kept and the realtor picks.

train() runs this after its main steps when given an AIVersion (train.py).
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

import numpy as np
import torch
from PIL import Image, ImageFilter

from . import shell as room_shell
from .capture import Capture


class Fixer(Protocol):
    """Cleans up renders of the splats: (H, W, 3) uint8 images in, the same sizes out."""

    name: str

    def __call__(self, images: list[np.ndarray]) -> list[np.ndarray]: ...


@dataclass
class EnhanceConfig:
    # Rounds of: render the views, clean them up, train on them next to the photos. Round r (of n)
    # starts its views r/n of the way from the photo they're near to where they end.
    rounds: int = 3
    steps_per_round: int = 1500
    # Up to `views` views where buyers walk: each starts at a photo's spot and ends `min_offset` to
    # `max_offset` m away across the room, at eye height (`eye_height` m above the floor; the photo's
    # height where its room isn't known), turned up to `max_turn` degrees, and nearly level.
    views: int = 120
    width: int = 1024  # the fixer's size (16:9)
    height: int = 576
    fov: float = 75.0  # horizontal, degrees
    min_offset: float = 0.25
    max_offset: float = 1.0
    max_turn: float = 35.0
    eye_height: tuple[float, float] = (1.35, 1.65)
    # Nothing a photo saw within this many meters of a view (and its path from the photo's spot).
    clearance: float = 0.3
    # The cleaned views: their share of the steps, and their loss's weight against a photo's.
    view_share: float = 0.3
    view_weight: float = 0.5
    seed: int = 1

    @property
    def steps(self) -> int:
        return self.rounds * self.steps_per_round


@dataclass
class AIVersion:
    """What train() needs for the AI-enhanced version: the fixer, how to use it, and what to do with
    the faithful version as soon as it's ready (`on_main`, given train's Result)."""

    fixer: Fixer
    config: EnhanceConfig = field(default_factory=EnhanceConfig)
    on_main: Callable[[Any], None] | None = None


@dataclass
class View:
    """A view the AI phase trains on: from `start` (the spot photo `photo` was taken from) to `end`,
    OpenCV camera-to-world matrices."""

    photo: int
    start: np.ndarray
    end: np.ndarray


def look(position, yaw: float, pitch: float) -> np.ndarray:
    """OpenCV camera-to-world at `position`, level, looking along `yaw` (0: along -z, π/2: along -x)
    and `pitch` (up is positive): the convention of photo_spots in job.py."""
    f = np.array([-math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)])
    right = np.cross(f, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, np.cross(f, right), f, position
    return m


def heading(camtoworld: np.ndarray) -> tuple[float, float]:
    """Yaw and pitch of an OpenCV camera-to-world (see look())."""
    f = camtoworld[:3, 2]
    return math.atan2(-f[0], -f[2]), math.asin(max(-1.0, min(1.0, float(f[1]))))


def between(view: View, t: float) -> np.ndarray:
    """The view `t` of the way from its photo's spot (0) to its end (1): along the line, turned as far."""
    yaw0, pitch0 = heading(view.start)
    yaw1, pitch1 = heading(view.end)
    turn = (yaw1 - yaw0 + math.pi) % (2 * math.pi) - math.pi
    position = (1 - t) * view.start[:3, 3] + t * view.end[:3, 3]
    return look(position, yaw0 + t * turn, pitch0 + t * (pitch1 - pitch0))


def intrinsics(cfg: EnhanceConfig) -> np.ndarray:
    fx = cfg.width / 2 / math.tan(math.radians(cfg.fov) / 2)
    return np.array([[fx, 0, cfg.width / 2], [0, fx, cfg.height / 2], [0, 0, 1]])


def _rooms(capture: Capture) -> list[tuple[torch.Tensor, float]]:
    """Each room's outline (x, z) and floor height, where cameras.json has them."""
    rooms = []
    for room in capture.rooms:
        try:
            poly = np.asarray(room.get("polygon") or [], dtype=np.float64).reshape(-1, 2)
            floor = float(room["floorY"])
        except (KeyError, TypeError, ValueError):
            continue
        if len(poly) >= 3 and np.isfinite(poly).all() and math.isfinite(floor):
            rooms.append((torch.tensor(poly, dtype=torch.float32), floor))
    return rooms


def choose_views(capture: Capture, cfg: EnhanceConfig, rng: np.random.Generator, tries: int = 8) -> list[View]:
    """Up to cfg.views views where buyers walk, spread over the photos: `tries` candidates per photo,
    kept if they end inside a room (when the rooms are known) and the house's bounds, clear of every
    surface the photos saw, and get there from the photo's spot without passing through or brushing
    past one (a photo taken right against something starts none)."""
    cams = capture.cameras
    rooms = _rooms(capture)
    seeds = torch.from_numpy(np.ascontiguousarray(capture.seeds_xyz, dtype=np.float32))
    # near(): a seed within about one cell (up to two): views keep `clearance`, paths a few cm.
    crowded = room_shell.SurfaceIndex(seeds, cfg.clearance)
    brushed = room_shell.SurfaceIndex(seeds, 0.06)
    lo, hi = np.asarray(capture.bounds_min, float), np.asarray(capture.bounds_max, float)

    candidates: list[View] = []
    for i, cam in enumerate(cams):
        p0 = cam.camtoworld[:3, 3]
        yaw0, pitch0 = heading(cam.camtoworld)
        home = None
        for poly, floor in rooms:
            if room_shell.inside_polygon(torch.tensor([[p0[0], p0[2]]], dtype=torch.float32), poly)[0]:
                home = floor
                break
        for _ in range(tries):
            angle, reach = rng.uniform(0, 2 * math.pi), rng.uniform(cfg.min_offset, cfg.max_offset)
            p = p0 + np.array([math.cos(angle) * reach, 0.0, math.sin(angle) * reach])
            p[1] = home + rng.uniform(*cfg.eye_height) if home is not None else p0[1] + rng.uniform(-0.1, 0.1)
            yaw = yaw0 + math.radians(rng.uniform(-cfg.max_turn, cfg.max_turn))
            pitch = 0.5 * pitch0 + math.radians(rng.uniform(-5, 5))
            candidates.append(View(i, cam.camtoworld, look(p, yaw, pitch)))
    if not candidates:
        return []

    ends = np.stack([v.end[:3, 3] for v in candidates])
    ok = ((ends > lo + 0.1) & (ends < hi - 0.1)).all(1)
    ok &= ~crowded.near(torch.from_numpy(ends.astype(np.float32))).numpy()
    if rooms:
        xz = torch.from_numpy(ends[:, [0, 2]].astype(np.float32))
        inside = torch.zeros(len(ends), dtype=torch.bool)
        for poly, _ in rooms:
            inside |= room_shell.inside_polygon(xz, poly)
        ok &= inside.numpy()
    # The way there, every few centimeters from the photo's spot on: through nothing, past nothing.
    starts = np.stack([v.start[:3, 3] for v in candidates])
    for t in np.linspace(0.0, 1.0, int(math.ceil(cfg.max_offset / 0.03)) + 1):
        ok &= ~brushed.near(torch.from_numpy(((1 - t) * starts + t * ends).astype(np.float32))).numpy()

    # Round robin over the photos, so the views spread over the whole home.
    per_photo: dict[int, list[View]] = {}
    for v, good in zip(candidates, ok):
        if good:
            per_photo.setdefault(v.photo, []).append(v)
    chosen: list[View] = []
    photos = list(per_photo)
    rng.shuffle(photos)
    while len(chosen) < cfg.views and any(per_photo.values()):
        for i in photos:
            if per_photo[i] and len(chosen) < cfg.views:
                chosen.append(per_photo[i].pop(0))
    return chosen


def to_jpeg(image: np.ndarray, quality: int = 95) -> bytes:
    out = io.BytesIO()
    Image.fromarray(image).save(out, "JPEG", quality=quality)
    return out.getvalue()


def from_jpeg(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as im:
        return np.asarray(im.convert("RGB"))


class SmoothingFixer:
    """A stand-in for the real fixer (tests, runs without a GPU): a light median filter, which removes
    single-pixel speckle the way a clean-up would and changes little else."""

    name = "median-3"

    def __call__(self, images: list[np.ndarray]) -> list[np.ndarray]:
        return [np.asarray(Image.fromarray(im).filter(ImageFilter.MedianFilter(3))) for im in images]
