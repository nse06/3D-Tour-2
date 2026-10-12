"""The room layout the phone sends with the photos (build 13 on; cameras.json "layout",
docs/photoreal.md §1): walls, doors and windows, and RoomPlan's furniture boxes, in the model's frame.
Scans from before build 13 have none: the stages that need it are skipped."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


@dataclass
class Wall:
    id: str
    a: np.ndarray  # plan point [x, z]
    b: np.ndarray
    inside: np.ndarray  # unit normal into the room, [x, z]
    y0: float
    y1: float
    thickness: float
    holes: list[dict] = field(default_factory=list)  # {s0, s1, y0, y1, kind}: cut through for doorways
    room: int | None = None

    @property
    def length(self) -> float:
        return float(np.linalg.norm(self.b - self.a))

    @property
    def along(self) -> np.ndarray:
        return (self.b - self.a) / max(self.length, 1e-9)


@dataclass
class Opening:
    id: str
    kind: str  # "door", "window", "opening"
    center: np.ndarray  # [x, y, z]
    along: np.ndarray  # unit, along the wall
    normal: np.ndarray  # unit, either way out of the wall
    width: float
    height: float
    wall: str | None = None
    open: bool | None = None


@dataclass
class Box:
    """A RoomPlan object: an oriented box (axes are its columns: width, up, depth), full `size`."""

    id: str
    category: str
    center: np.ndarray
    axes: np.ndarray  # (3, 3): rows are the box's x (width), y (up) and z (depth) axes
    size: np.ndarray
    lidar: bool = False  # the LiDAR mesh replaced the box in the painted model
    room: int | None = None

    def local(self, points: np.ndarray) -> np.ndarray:
        """Points in the box's frame (meters along its axes, from its center)."""
        return (np.asarray(points, np.float64) - self.center) @ self.axes.T

    def contains(self, points: np.ndarray, margin: float = 0.0) -> np.ndarray:
        return (np.abs(self.local(points)) <= self.size / 2 + margin).all(-1)

    def corners(self) -> np.ndarray:
        signs = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], np.float64)
        return self.center + (signs * self.size / 2) @ self.axes


@dataclass
class Layout:
    walls: list[Wall] = field(default_factory=list)
    openings: list[Opening] = field(default_factory=list)
    objects: list[Box] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not (self.walls or self.openings or self.objects)

    def objects_of(self, *categories: str) -> list[Box]:
        return [o for o in self.objects if o.category in categories]


def _vec(value, n: int) -> np.ndarray | None:
    try:
        v = np.asarray(value, dtype=np.float64).reshape(n)
    except (TypeError, ValueError):
        return None
    return v if np.isfinite(v).all() else None


def parse(doc: dict) -> Layout:
    """The layout of a cameras.json document (empty if it has none); malformed entries are skipped."""
    raw = doc.get("layout") or {}
    out = Layout()
    for w in raw.get("walls", []) or []:
        a, b, inside = _vec(w.get("a"), 2), _vec(w.get("b"), 2), _vec(w.get("inside"), 2)
        try:
            y0, y1, t = float(w["y0"]), float(w["y1"]), float(w.get("thickness", 0.12))
        except (KeyError, TypeError, ValueError):
            continue
        if a is None or b is None or inside is None or not (y1 > y0):
            continue
        out.walls.append(Wall(str(w.get("id", "")), a, b, inside / max(np.linalg.norm(inside), 1e-9), y0, y1, t, list(w.get("holes") or []), w.get("room")))
    for o in raw.get("openings", []) or []:
        center, along, normal = _vec(o.get("center"), 3), _vec(o.get("along"), 3), _vec(o.get("normal"), 3)
        try:
            width, height = float(o["width"]), float(o["height"])
        except (KeyError, TypeError, ValueError):
            continue
        if center is None or along is None or normal is None or width <= 0 or height <= 0:
            continue
        out.openings.append(Opening(str(o.get("id", "")), str(o.get("kind", "opening")), center, along, normal, width, height, o.get("wall"), o.get("open")))
    for o in raw.get("objects", []) or []:
        center, size = _vec(o.get("center"), 3), _vec(o.get("size"), 3)
        axes = _vec(o.get("axes"), 9)
        if center is None or size is None or axes is None or (size <= 0).any():
            continue
        axes = axes.reshape(3, 3)
        axes = axes / np.maximum(np.linalg.norm(axes, axis=1, keepdims=True), 1e-9)
        out.objects.append(Box(str(o.get("id", "")), str(o.get("category", "")), center, axes, size, bool(o.get("lidar", False)), o.get("room")))
    return out


def load(capture_dir: Path) -> Layout:
    return parse(json.loads((Path(capture_dir) / "cameras.json").read_text()))
