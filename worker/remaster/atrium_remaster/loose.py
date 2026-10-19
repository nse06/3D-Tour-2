"""Loose pieces (docs/remaster.md §4.0): what the scanner kept that isn't there.

The LiDAR mesh keeps whatever stood in front of it while it scanned. Someone walking through leaves
pieces of legs hanging in the room; a shoe or a heap of clothes keeps only its top, floating a few
centimeters over the floor. The phone drops them since builds 19 and 20 (MeshShapes.dropLoosePieces),
but scans sent before still carry them, and the phone never checks a piece against the photos. Before
anything here learns from the model:

* by the phone's rules (`run`): a piece that touches nothing (more than 12 cm off the floor, 15 cm
  from every wall and 60 cm under the ceiling, in no RoomPlan box, no wider than 80 cm, no bigger
  than 0.25 m²) goes, and so does low clutter on the floor (starting within 17 cm of it, no taller than
  30 cm and rising at least 3 cm, no wider than 1 m, in no box), which the floor's photos then show as
  it is;
* by the photos (`seen_through`, once the depth model has measured them, depth.py): a small piece
  that most photos looking at it see straight through (the depth model finds the room farther away
  than the piece, inside its outline) isn't there either, near a wall or not.

What goes is counted in the stats: the job's check on the scan.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage, sparse
from scipy.sparse import csgraph

from atrium_photoreal.capture import Capture

from .edit import apply
from .layout import Layout
from .scene import Mesh
from .views import Caster


@dataclass(frozen=True)
class LooseConfig:
    weld: float = 0.001  # vertices this close are one (charts split the mesh along their seams)
    float_clearance: float = 0.12  # a floating piece starts more than this above the floor
    wall_clearance: float = 0.15  # ... is this far from every wall
    ceiling_clearance: float = 0.6  # ... ends this far under the ceiling
    float_width: float = 0.8  # ... measures at most this corner to corner
    float_area: float = 0.25  # ... and has at most this much surface (m²)
    low_start: float = 0.17  # low clutter starts within this of the floor
    low_height: float = 0.3  # ... ends at most this high
    low_width: float = 1.0  # ... and is at most this wide across the floor
    low_rise: float = 0.03  # ... and rises at least this far above it (flat at the floor, it's floor: a doorway's patch)
    box_margin: float = 0.1  # a piece whose middle is this close to a RoomPlan box is the box's
    # Seen through by the photos: pieces up to `seen_area`, judged on pixels inside their outline in
    # at least `seen_photos` photos, `seen_pixels` in all, `seen_share` of them looking past the piece.
    seen_area: float = 0.5
    seen_photos: int = 3
    seen_pixels: int = 60
    seen_share: float = 0.75
    agree_abs: float = 0.04
    agree_rel: float = 0.04


def pieces(mesh: Mesh, weld: float = 0.001) -> tuple[np.ndarray, int]:
    """(F,) the connected piece each triangle belongs to (vertices welded by position), and how many."""
    key = np.round(np.asarray(mesh.vertices, np.float64) / weld).astype(np.int64)
    _, welded = np.unique(key, axis=0, return_inverse=True)
    f = welded.ravel()[mesh.faces]
    n = int(f.max()) + 1 if len(f) else 0
    rows = np.concatenate([f[:, 0], f[:, 1]])
    cols = np.concatenate([f[:, 1], f[:, 2]])
    graph = sparse.coo_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(n, n))
    count, label = csgraph.connected_components(graph, directed=False)
    used, piece = np.unique(label[f[:, 0]], return_inverse=True)
    return piece.ravel(), len(used)


@dataclass
class Pieces:
    """Each piece's bounds, surface and middle."""

    of_face: np.ndarray  # (F,)
    lo: np.ndarray  # (P, 3)
    hi: np.ndarray
    area: np.ndarray  # (P,)

    @property
    def middle(self) -> np.ndarray:
        return (self.lo + self.hi) / 2


def measure(mesh: Mesh, cfg: LooseConfig) -> Pieces:
    of_face, count = pieces(mesh, cfg.weld)
    tri = np.asarray(mesh.vertices, np.float64)[mesh.faces]
    index = np.arange(count)
    lo = np.stack([ndimage.minimum(tri[:, :, k].min(1), of_face, index) for k in range(3)], 1)
    hi = np.stack([ndimage.maximum(tri[:, :, k].max(1), of_face, index) for k in range(3)], 1)
    area = np.bincount(of_face, weights=mesh.face_areas, minlength=count)
    return Pieces(of_face, np.asarray(lo).reshape(count, 3), np.asarray(hi).reshape(count, 3), area)


@dataclass
class Level:
    """A room's outline on the floor plan, its floor and its ceiling."""

    polygon: np.ndarray  # (N, 2) plan, [x, z]
    floor: float
    ceiling: float


def levels(capture: Capture, layout: Layout) -> list[Level]:
    """The rooms' floors and ceilings: the capture's rooms, or the layout's walls room by room."""
    out = []
    for r in capture.rooms or []:
        try:
            polygon = np.asarray(r["polygon"], np.float64).reshape(-1, 2)
            out.append(Level(polygon, float(r["floorY"]), float(r["ceilingY"])))
        except (KeyError, TypeError, ValueError):
            continue
    if out:
        return out
    rooms: dict = {}
    for w in layout.walls:
        rooms.setdefault(w.room, []).append(w)
    for walls in rooms.values():
        points = np.array([p for w in walls for p in (w.a, w.b)])
        lo, hi = points.min(0), points.max(0)
        polygon = np.array([[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]])
        out.append(Level(polygon, min(w.y0 for w in walls), max(w.y1 for w in walls)))
    return out


def inside(polygon: np.ndarray, point: np.ndarray) -> bool:
    x, z = point
    hit = False
    for (x0, z0), (x1, z1) in zip(polygon, np.roll(polygon, -1, 0)):
        if (z0 > z) != (z1 > z) and x < x0 + (z - z0) * (x1 - x0) / (z1 - z0):
            hit = not hit
    return hit


def level_of(rooms: list[Level], plan: np.ndarray) -> Level | None:
    """The room a plan point is in, or the nearest one's (a piece hanging over a doorway)."""
    if not rooms:
        return None
    for room in rooms:
        if inside(room.polygon, plan):
            return room

    def distance(room: Level) -> float:
        a, b = room.polygon, np.roll(room.polygon, -1, 0)
        ab = b - a
        t = np.clip(((plan - a) * ab).sum(1) / np.maximum((ab * ab).sum(1), 1e-12), 0, 1)
        return float(np.linalg.norm(a + t[:, None] * ab - plan, axis=1).min())

    return min(rooms, key=distance)


def walls_of(layout: Layout, rooms: list[Level]) -> list[tuple[np.ndarray, np.ndarray, float, float, float]]:
    """(a, b, thickness, y0, y1) per wall: the layout's, or the rooms' outlines."""
    if layout.walls:
        return [(w.a, w.b, w.thickness, w.y0, w.y1) for w in layout.walls]
    return [(a, b, 0.0, r.floor, r.ceiling) for r in rooms for a, b in zip(r.polygon, np.roll(r.polygon, -1, 0))]


def near_wall(points: np.ndarray, walls, margin: float) -> bool:
    """Whether any point (N, 3) is within `margin` of a wall's face."""
    plan, y = points[:, [0, 2]], points[:, 1]
    for a, b, thickness, y0, y1 in walls:
        length = float(np.linalg.norm(b - a))
        if length < 1e-6:
            continue
        along = (b - a) / length
        normal = np.array([-along[1], along[0]])
        s = (plan - a) @ along
        off = np.abs((plan - a) @ normal) - thickness / 2
        if ((off < margin) & (s > -margin) & (s < length + margin) & (y > y0 - margin) & (y < y1 + margin)).any():
            return True
    return False


def in_a_box(layout: Layout, middle: np.ndarray, margin: float) -> bool:
    return any(bool(box.contains(middle[None], margin)[0]) for box in layout.objects)


def run(mesh: Mesh, capture: Capture, layout: Layout, cfg: LooseConfig = LooseConfig(), log=print) -> tuple[Mesh, dict]:
    """The mesh without the loose pieces the phone's rules find."""
    stats = {"looseFloating": 0, "looseLow": 0, "looseArea": 0.0}
    rooms = levels(capture, layout)
    if not rooms:
        log("loose: no rooms to measure floors and walls by; nothing removed")
        return mesh, stats
    walls = walls_of(layout, rooms)
    found = measure(mesh, cfg)
    remove = np.zeros(len(found.area), bool)
    vertices = np.asarray(mesh.vertices, np.float64)
    across_plan = np.linalg.norm((found.hi - found.lo)[:, [0, 2]], axis=1)
    candidates = np.flatnonzero((found.area <= 2.0) & (across_plan <= max(cfg.float_width, cfg.low_width * 1.5)))
    order = np.argsort(found.of_face, kind="stable")
    starts = np.searchsorted(found.of_face[order], np.arange(len(found.area) + 1))
    for p in candidates:
        lo, hi, middle = found.lo[p], found.hi[p], found.middle[p]
        room = level_of(rooms, middle[[0, 2]])
        if room is None or in_a_box(layout, middle, cfg.box_margin):
            continue
        bottom, top = lo[1] - room.floor, hi[1] - room.floor
        across = hi - lo
        if bottom < cfg.low_start and cfg.low_rise <= top <= cfg.low_height and max(across[0], across[2]) <= cfg.low_width:
            remove[p] = True
            stats["looseLow"] += 1
        elif (
            bottom > cfg.float_clearance
            and hi[1] < room.ceiling - cfg.ceiling_clearance
            and float(np.linalg.norm(across)) <= cfg.float_width
            and found.area[p] <= cfg.float_area
        ):
            points = vertices[np.unique(mesh.faces[order[starts[p] : starts[p + 1]]])]
            if not near_wall(points, walls, cfg.wall_clearance):
                remove[p] = True
                stats["looseFloating"] += 1
    stats["looseArea"] = round(float(found.area[remove].sum()), 3)
    if not remove.any():
        log("loose: nothing loose")
        return mesh, stats
    out, _ = apply(mesh, remove[found.of_face], [])
    log(f"loose: {stats['looseFloating']} floating pieces and {stats['looseLow']} low ones off the floor ({stats['looseArea']} m²) removed")
    return out, stats


def seen_through(
    mesh: Mesh, capture: Capture, layout: Layout, depths: dict[str, tuple[np.ndarray, np.ndarray]], cfg: LooseConfig = LooseConfig(), log=print
) -> tuple[Mesh, dict]:
    """The mesh without the small pieces the photos see through. `depths`: per photo, the depth
    model's depth and the intrinsics at its size (depth.estimate)."""
    found = measure(mesh, cfg)
    small = (found.area <= cfg.seen_area) & ~np.array([in_a_box(layout, m, cfg.box_margin) for m in found.middle], bool)
    stats = {"looseSeenThrough": 0, "looseSeenThroughArea": 0.0}
    if not small.any():
        return mesh, stats
    caster = Caster.of(mesh)
    count = len(found.area)
    pixels = np.zeros(count, np.int64)
    through = np.zeros(count, np.int64)
    photos = np.zeros(count, np.int64)
    for cam in capture.cameras:
        if cam.name not in depths:
            continue
        predicted, K = depths[cam.name]
        h, w = predicted.shape
        hits = caster.view(K, cam.camtoworld, w, h)
        piece = np.where(hits.hit, found.of_face[np.where(hits.hit, hits.face, 0)], -1)
        # Inside a piece's outline only: at its edges any small misalignment disagrees.
        inner = piece >= 0
        for shift in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            inner &= np.roll(piece, shift, (0, 1)) == piece
        inner[[0, -1], :] = False
        inner[:, [0, -1]] = False
        inner &= small[np.maximum(piece, 0)]
        if not inner.any():
            continue
        modeled = hits.depth
        past = predicted > modeled + cfg.agree_abs + cfg.agree_rel * modeled
        ids = piece[inner]
        pixels += np.bincount(ids, minlength=count)
        through += np.bincount(ids[past[inner]], minlength=count)
        photos += np.bincount(np.unique(ids), minlength=count)
    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(pixels > 0, through / np.maximum(pixels, 1), 0.0)
    remove = small & (photos >= cfg.seen_photos) & (pixels >= cfg.seen_pixels) & (share >= cfg.seen_share)
    stats["looseSeenThrough"] = int(remove.sum())
    stats["looseSeenThroughArea"] = round(float(found.area[remove].sum()), 3)
    if not remove.any():
        log("loose: the photos see every piece that's there")
        return mesh, stats
    out, _ = apply(mesh, remove[found.of_face], [])
    log(f"loose: {stats['looseSeenThrough']} pieces the photos see through ({stats['looseSeenThroughArea']} m²) removed")
    return out, stats
