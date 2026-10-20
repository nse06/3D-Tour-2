"""AI-made furniture (docs/remaster.md §4.4).

The scan shows a sofa as RoomPlan's box or as the LiDAR's melted shape. For each movable piece in the
room layout (build 13: sofas, chairs, beds and tables, never built-ins), the photos that see it best
are picked and the piece is cut out of them (SAM 2.1, its box as the prompt). An image-to-3D model
(TripoSG) makes its shape from the clearest cutout. The shape is turned until its outline matches the
cutouts in all those photos, stretched into the box the scan measured, and put in place of the scanned
piece. The skins (skins.py) then learn its colors from the photos like everything else; sides no
photo saw start as the piece's color. A shape that doesn't match the photos well enough isn't used,
nor one that matches them no better than the scanned piece does (a chair the LiDAR caught whole and
the photos painted well stays as it is), and the scanned piece stays.

The AI reviewer (review.py) can pick pieces too, storage among them, and when it has looked the scan
over, only its picks are made (shapes for every piece cost minutes of GPU and real homes' scans rarely
lose to them on outlines). It saw the scanned piece is broken, so a pick needn't match the photos
better than the scan does (a hole hardly changes an outline): a box only roughly where the photos
show the piece, a made shape as well as any other.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from PIL import Image, ImageDraw

from .edit import Addition, apply, box
from .layout import Box, Layout
from .scene import Mesh
from .views import Caster

MOVABLE = ("sofa", "chair", "bed", "table")


class Segmenter(Protocol):
    name: str

    def __call__(self, image: np.ndarray, boxes: list[tuple[float, float, float, float]]) -> list[np.ndarray]:
        """One (H, W) bool mask per box (pixels: x0, y0, x1, y1) of an (H, W, 3) uint8 photo."""


class ShapeMaker(Protocol):
    name: str

    def __call__(self, images: list[np.ndarray]) -> list[tuple[np.ndarray, np.ndarray] | None]:
        """Per (S, S, 3) uint8 image of one piece on white, its shape: (V, 3) vertices and (F, 3)
        triangles in a frame and scale of the maker's own; None where it made nothing."""


class BoxSegmenter:
    """Stand-in for tests: the prompt's box is the mask."""

    name = "box"

    def __call__(self, image, boxes):
        h, w = image.shape[:2]
        out = []
        for x0, y0, x1, y1 in boxes:
            mask = np.zeros((h, w), bool)
            mask[max(0, int(y0)) : min(h, math.ceil(y1)), max(0, int(x0)) : min(w, math.ceil(x1))] = True
            out.append(mask)
        return out


@dataclass
class FurnitureConfig:
    categories: tuple[str, ...] = MOVABLE
    long_side: int = 960  # photos are read at this size
    views: int = 5  # photos each shape is fitted to
    min_size: float = 0.12  # a photo shows the piece's box at least this big (its projection's long side, of the photo's)
    in_frame: float = 0.9  # the cutout's photo has this much of the projection in its frame (the others half)
    spread: float = 20.0  # degrees between the directions the photos look at the piece from, where possible
    crop: int = 768  # the cutout goes to the shape maker this big
    pad: float = 0.1  # with this much white around it (of its longer side), as TripoSG expects
    fit_px: int = 192  # outlines are compared this big
    min_iou: float = 0.6  # a shape matching the cutouts less well than this isn't used
    better_by: float = 0.05  # ... nor one matching them less than this better than the scanned piece
    box_iou: float = 0.3  # a reviewer's box pick (RoomPlan's box) matching the cutouts less than this isn't used
    upright: bool = True  # the shape maker makes things standing up (y up): only turn them about it
    max_faces: int = 30000
    margin: float = 0.03  # the scanned piece: what lies within this of its box


@dataclass
class Sight:
    """A photo that sees a piece: its intrinsics at the size it's read at, the piece's box there."""

    camera: object  # atrium_photoreal.capture.Camera
    K: np.ndarray
    width: int
    height: int
    box: tuple[float, float, float, float]
    hull: np.ndarray  # (N, 2) the box's projected corners
    seen: int  # pixels showing the scanned piece
    framed: float  # how much of the box's projection is in the frame
    score: float
    direction: np.ndarray  # unit, from the camera to the piece


@dataclass
class FitView:
    """A photo's cutout of a piece at the size outlines are compared at, and what's in front of it."""

    K: np.ndarray
    camtoworld: np.ndarray
    width: int
    height: int
    mask: np.ndarray  # (h, w) bool
    scene: np.ndarray  # (h, w) depth of the model without the piece (inf: nothing)


def piece_faces(mesh: Mesh, box: Box, chart: np.ndarray, flat: set[int], margin: float) -> np.ndarray:
    """(F,) bool: the scanned piece. Triangles wholly in its box, of charts lying mostly in it (a box's
    faces) or of the LiDAR's curved shapes; never the floor, a wall or a baseboard running under or
    behind it."""
    inside = box.contains(mesh.vertices[mesh.faces].reshape(-1, 3), margin).reshape(-1, 3).all(1)
    if not inside.any():
        return inside
    areas = mesh.face_areas
    n = int(chart.max()) + 1
    share = np.bincount(chart[inside], weights=areas[inside], minlength=n) / np.maximum(np.bincount(chart, weights=areas, minlength=n), 1e-12)
    curved = np.ones(n, bool)
    curved[list(flat)] = False
    return inside & ((share[chart] >= 0.5) | curved[chart])


def project(points: np.ndarray, K: np.ndarray, camtoworld: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pixels and depths of world points in an OpenCV camera."""
    local = (np.asarray(points, np.float64) - camtoworld[:3, 3]) @ camtoworld[:3, :3]
    z = local[:, 2]
    uv = local[:, :2] / np.maximum(z[:, None], 1e-6) * np.array([K[0, 0], K[1, 1]]) + K[:2, 2]
    return uv, z


def scaled(camera, long_side: int) -> tuple[np.ndarray, int, int]:
    from atrium_photoreal.capture import training_size

    w, h, _ = training_size(camera, long_side)
    K = camera.K.astype(np.float64).copy()
    K[0] *= w / camera.width
    K[1] *= h / camera.height
    return K, w, h


def sights(caster: Caster, piece: np.ndarray, box: Box, cameras: list, cfg: FurnitureConfig) -> list[Sight]:
    """The photos that see at least half of a piece, big enough, best first: by how many pixels show
    it, the steadier photo first when it's a tie."""
    from atrium_photoreal.sharpness import smear_px

    corners = box.corners()
    ids = np.flatnonzero(piece)
    out = []
    for cam in cameras:
        K, w, h = scaled(cam, cfg.long_side)
        uv, z = project(corners, K, cam.camtoworld)
        if (z < 0.2).any():
            continue
        (x0, y0), (x1, y1) = uv.min(0), uv.max(0)
        cx0, cy0, cx1, cy1 = max(x0, 0.0), max(y0, 0.0), min(x1, w), min(y1, h)
        if cx1 <= cx0 or cy1 <= cy0 or max(x1 - x0, y1 - y0) < cfg.min_size * max(w, h):
            continue
        framed = (cx1 - cx0) * (cy1 - cy0) / max((x1 - x0) * (y1 - y0), 1e-9)
        if framed < 0.5:
            continue
        step = max(2.0, max(x1 - x0, y1 - y0) / 48)
        xs, ys = np.meshgrid(np.arange(cx0 + step / 2, cx1, step), np.arange(cy0 + step / 2, cy1, step))
        d = np.stack([(xs - K[0, 2]) / K[0, 0], (ys - K[1, 2]) / K[1, 1], np.ones_like(xs)], -1).reshape(-1, 3) @ cam.camtoworld[:3, :3].T
        _, face, _ = caster.rays(np.broadcast_to(cam.camtoworld[:3, 3], d.shape), d)
        seen = int(np.isin(face, ids).sum() * step * step)
        if seen < 0.05 * (x1 - x0) * (y1 - y0):
            continue
        toward = box.center - cam.camtoworld[:3, 3]
        smear = smear_px(cam, w / cam.width) or 0.0
        out.append(Sight(cam, K, w, h, (float(x0), float(y0), float(x1), float(y1)), uv, seen, framed, seen / (1 + 0.25 * smear), toward / np.linalg.norm(toward)))
    return sorted(out, key=lambda s: -s.score)


def spread_out(found: list[Sight], count: int, degrees: float) -> list[Sight]:
    """The best `count`, looking at the piece from directions at least `degrees` apart where possible."""
    chosen: list[Sight] = []
    for s in found:
        if len(chosen) < count and all(math.degrees(math.acos(float(np.clip(s.direction @ c.direction, -1, 1)))) >= degrees for c in chosen):
            chosen.append(s)
    for s in found:
        if len(chosen) < count and not any(s is c for c in chosen):
            chosen.append(s)
    return chosen


def hull_mask(points: np.ndarray, width: int, height: int, grow: float) -> np.ndarray:
    """The convex hull of projected points, grown by `grow` of its size, as an (H, W) mask."""
    from scipy.spatial import ConvexHull

    center = points.mean(0)
    size = float(np.max(points.max(0) - points.min(0)))
    pts = points + (points - center) / np.maximum(np.linalg.norm(points - center, axis=1, keepdims=True), 1e-9) * grow * size
    hull = pts[ConvexHull(pts).vertices]
    canvas = Image.new("L", (width, height), 0)
    ImageDraw.Draw(canvas).polygon([tuple(map(float, p)) for p in hull], fill=255)
    return np.asarray(canvas) > 127


def cutout(image: np.ndarray, mask: np.ndarray, size: int, pad: float) -> np.ndarray:
    """The piece on white, centered in a square with `pad` of its longer side around it."""
    ys, xs = np.nonzero(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    piece = np.where(mask[y0:y1, x0:x1, None], image[y0:y1, x0:x1], 255).astype(np.uint8)
    side = int(round(max(y1 - y0, x1 - x0) * (1 + 2 * pad)))
    canvas = np.full((side, side, 3), 255, np.uint8)
    oy, ox = (side - (y1 - y0)) // 2, (side - (x1 - x0)) // 2
    canvas[oy : oy + y1 - y0, ox : ox + x1 - x0] = piece
    return np.asarray(Image.fromarray(canvas).resize((size, size), Image.LANCZOS))


def hidden(caster: Caster, ids: np.ndarray, alone: Caster, s: Sight) -> tuple[np.ndarray, np.ndarray]:
    """In a photo: where the scanned piece would show with nothing in front of it (its outline), and
    where something in front of it hides it (a coffee table before a sofa)."""
    hits = caster.view(s.K, s.camera.camtoworld, s.width, s.height)
    mine = alone.view(s.K, s.camera.camtoworld, s.width, s.height)
    hides = mine.hit & ~np.isin(hits.face, ids) & (hits.depth < mine.depth - 0.02)
    return mine.hit, hides


def fit_view(s: Sight, mask: np.ndarray, scene: Caster, fit_px: int) -> FitView:
    scale = fit_px / max(s.width, s.height)
    w, h = max(8, round(s.width * scale)), max(8, round(s.height * scale))
    K = s.K.copy()
    K[0] *= w / s.width
    K[1] *= h / s.height
    small = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize((w, h), Image.BILINEAR)) > 127
    return FitView(K, s.camera.camtoworld, w, h, small, scene.view(K, s.camera.camtoworld, w, h).depth)


def orientations(upright: bool = True) -> list[np.ndarray]:
    """The ways to lay a shape's axes along a box's: every axis to every axis, either way (48), or
    only those keeping its up axis up (8: four quarter turns, mirrored or not)."""
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1.0, -1.0), repeat=3):
            R = np.zeros((3, 3))
            R[np.arange(3), perm] = signs
            if not upright or R[1, 1] == 1.0:
                out.append(R)
    return out


def placed(vertices: np.ndarray, R: np.ndarray, box: Box) -> np.ndarray:
    """The shape turned by R and stretched to fill the box."""
    v = np.asarray(vertices, np.float64) @ R.T
    lo, hi = v.min(0), v.max(0)
    local = (v - (lo + hi) / 2) / np.maximum(hi - lo, 1e-9) * box.size
    return box.center + local @ box.axes


def outline_iou(vertices: np.ndarray, faces: np.ndarray, views: list[FitView]) -> float:
    """How well a placed shape's outline matches the cutouts, where nothing in front hides it."""
    caster = Caster(vertices, faces)
    inter = union = 0
    for v in views:
        hits = caster.view(v.K, v.camtoworld, v.width, v.height)
        valid = ~(hits.hit & (v.scene < hits.depth - 0.02))
        inter += int((hits.hit & v.mask & valid).sum())
        union += int(((hits.hit | v.mask) & valid).sum())
    return inter / union if union else 0.0


def simplify(vertices: np.ndarray, faces: np.ndarray, target: int) -> tuple[np.ndarray, np.ndarray]:
    if len(faces) <= target:
        return vertices, faces
    import open3d as o3d

    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.asarray(vertices, np.float64)), o3d.utility.Vector3iVector(np.asarray(faces, np.int32)))
    m = m.merge_close_vertices(1e-7).simplify_quadric_decimation(target)
    m.remove_degenerate_triangles()
    m.remove_unreferenced_vertices()
    return np.asarray(m.vertices), np.asarray(m.triangles, np.int64)


def main_parts(vertices: np.ndarray, faces: np.ndarray, share: float = 0.02) -> tuple[np.ndarray, np.ndarray]:
    """The shape without specks: connected parts under `share` of its area are dropped."""
    import open3d as o3d

    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.asarray(vertices, np.float64)), o3d.utility.Vector3iVector(np.asarray(faces, np.int32)))
    labels, _, areas = m.cluster_connected_triangles()
    labels, areas = np.asarray(labels), np.asarray(areas)
    if len(areas) <= 1:
        return np.asarray(vertices, np.float64), np.asarray(faces, np.int64)
    m.remove_triangles_by_mask(areas[labels] < share * areas.sum())
    m.remove_unreferenced_vertices()
    return np.asarray(m.vertices), np.asarray(m.triangles, np.int64)


def outward(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """The triangles wound so the shape's normals point out (its signed volume positive)."""
    a, b, c = (vertices[faces[:, k]] for k in range(3))
    volume = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6
    return faces if volume >= 0 else faces[:, [0, 2, 1]]


def fit(vertices: np.ndarray, faces: np.ndarray, box: Box, views: list[FitView], upright: bool = True, fit_faces: int = 4000) -> tuple[np.ndarray, np.ndarray, float]:
    """The shape placed in the box the way its outline best matches the cutouts: the placed vertices,
    its triangles (wound outward) and how well it matched (IoU). With few photos many turns match
    (a plate on its edge looks like a box from the front), so a shape the maker made standing up is
    only turned about its up axis; upright and unmirrored win ties."""
    small_v, small_f = simplify(vertices, faces, fit_faces)
    best = None
    for R in orientations(upright):
        iou = outline_iou(placed(small_v, R, box), small_f, views)
        prior = 0.02 * (R[1, 1] == 1.0) + 0.01 * (np.linalg.det(R) > 0)
        if best is None or iou + prior > best[0]:
            best = (iou + prior, iou, R)
    _, iou, R = best
    world = placed(vertices, R, box)
    return world, outward(world, np.asarray(faces, np.int64)), iou


def photo(s: Sight, sharpened: dict | None) -> np.ndarray:
    from atrium_photoreal.capture import load_photo

    if sharpened and s.camera.name in sharpened:
        return np.asarray(Image.fromarray(np.asarray(sharpened[s.camera.name], np.uint8)).resize((s.width, s.height), Image.LANCZOS))
    return load_photo(s.camera, max(s.width, s.height))[0]


def run(
    mesh: Mesh,
    capture,
    layout: Layout,
    segmenter: Segmenter,
    maker: ShapeMaker,
    cfg: FurnitureConfig = FurnitureConfig(),
    sharpened: dict | None = None,
    log=print,
    inpainter=None,
    progress=None,
    also: dict | None = None,
    only_also: bool = False,
) -> tuple[Mesh, dict]:
    """The mesh with its movable pieces made by the shape maker, where their shapes match the photos.
    `also`: RoomPlan ids made too whatever their category, each "made" (by the shape maker) or "box"
    (RoomPlan's own box: a dresser, a cabinet), the reviewer's picks (review.py); `only_also`: only those.
    `inpainter` (fill.Inpainter): what's hidden behind something in the cutout's photo is painted in
    before the shape maker sees it (else the gap would end up in the piece's shape). `progress(share
    done)`: the cutouts are the first 20%, the shapes (a piece at a time) the next 65%, the fits the rest."""
    from scipy import ndimage

    also = also or {}

    from .fill import flat_charts

    def done(share: float) -> None:
        if progress is not None:
            progress(share)

    pieces = [b for b in layout.objects if b.id in also or (b.category in cfg.categories and not only_also)]
    stats: dict = {"furnitureMade": 0, "furnitureKept": 0, "furnitureFit": {}, "furnitureScannedFit": {}, "furnitureIds": []}
    if not pieces:
        return mesh, stats
    chart = mesh.charts()
    flat = set(flat_charts(mesh, chart, 10.0))
    caster = Caster.of(mesh)
    plans = []
    for i, b in enumerate(pieces):
        done(0.2 * i / len(pieces))
        piece = piece_faces(mesh, b, chart, flat, cfg.margin)
        found = sights(caster, piece, b, capture.cameras, cfg) if piece.any() else []
        boxed = also.get(b.id) == "box"
        # RoomPlan's box needs no cutout to make it from, only photos to check it against.
        whole = [s for s in found if s.framed >= cfg.in_frame] or (found if boxed else [])
        if not whole:
            log(f"furniture: {b.category} {b.id}: no photo shows it whole")
            stats["furnitureKept"] += 1
            continue
        scene = Caster(mesh.vertices, mesh.faces[~piece])
        ids, alone = np.flatnonzero(piece), Caster(mesh.vertices, mesh.faces[piece])
        # The cutout's photo: of the clearest whole views, the one where the least of it is hidden.
        best, best_score, best_hides = whole[0], -1.0, None
        for s in whole[:6]:
            outline, hides = hidden(caster, ids, alone, s)
            score = s.seen * (1 - hides.sum() / max(1, outline.sum())) ** 2
            if score > best_score:
                best, best_score, best_hides = s, score, hides
        views, crop, color = [], None, None
        # That view first, then others around it, for the fit.
        for s in spread_out([best] + [s for s in found if s is not best], cfg.views, cfg.spread):
            image = photo(s, sharpened)
            x0, y0, x1, y1 = s.box
            gx, gy = 0.05 * (x1 - x0), 0.05 * (y1 - y0)
            (mask,) = segmenter(image, [(max(0.0, x0 - gx), max(0.0, y0 - gy), min(s.width, x1 + gx), min(s.height, y1 + gy))])
            # Holes in the cutout are the piece's too (a throw on a sofa's seat).
            mask = ndimage.binary_fill_holes(np.asarray(mask, bool) & hull_mask(s.hull, s.width, s.height, 0.04))
            if mask.sum() < 0.1 * s.seen:
                continue
            if crop is None and s is best:
                # What hides it shows there, whether or not the cutout took it in: painted over.
                cut = mask
                if inpainter is not None and best_hides.sum() > 0.01 * mask.sum():
                    (image,) = inpainter([image], [best_hides])
                    cut = mask | best_hides
                crop, color = cutout(image, cut, cfg.crop, cfg.pad), np.median(image[mask], 0) / 255
            if color is None:
                color = np.median(image[mask], 0) / 255
            views.append(fit_view(s, mask, scene, cfg.fit_px))
        if crop is None and not (boxed and views):
            log(f"furniture: {b.category} {b.id}: no cutout")
            stats["furnitureKept"] += 1
            continue
        plans.append((b, piece, crop, color, views))
    shapes = []
    for i, plan in enumerate(plans):
        done(0.2 + 0.65 * i / len(plans))
        # Box-shaped furniture with holes or warped sides is the box RoomPlan measured, the photos painting it.
        shapes += [box(np.zeros(3), np.eye(3), np.full(3, 2.0))] if also.get(plan[0].id) == "box" else maker([plan[2]])
    remove = np.zeros(len(mesh.faces), bool)
    additions: list[Addition] = []
    for i, ((b, piece, _, color, views), shape) in enumerate(zip(plans, shapes)):
        done(0.85 + 0.15 * i / len(plans))
        if shape is None or len(shape[1]) < 4:
            log(f"furniture: {b.category} {b.id}: no shape made")
            stats["furnitureKept"] += 1
            continue
        v, f = simplify(*main_parts(*shape), cfg.max_faces)
        world, f, iou = fit(v, f, b, views, cfg.upright)
        scanned = outline_iou(mesh.vertices, mesh.faces[piece], views)
        stats["furnitureFit"][b.id] = round(iou, 3)
        stats["furnitureScannedFit"][b.id] = round(scanned, 3)
        pick = also.get(b.id)
        need = cfg.box_iou if pick == "box" else cfg.min_iou if pick == "made" else max(cfg.min_iou, scanned + cfg.better_by)
        if iou < need:
            log(f"furniture: {b.category} {b.id}: its {'box' if pick == 'box' else 'shape'} matches the photos {iou:.2f}, the scanned one {scanned:.2f}: keeping the scanned one")
            stats["furnitureKept"] += 1
            continue
        log(f"furniture: {b.category} {b.id}: made ({len(f)} triangles, outline match {iou:.2f})")
        remove |= piece
        stats["furnitureIds"].append(b.id)
        additions.append(Addition(world.astype(np.float32), f, color=tuple(float(c) for c in color), name=f"furniture-{b.id}"))
    if not additions:
        return mesh, stats
    out, edit_stats = apply(mesh, remove, additions)
    stats["furnitureMade"] = len(additions)
    stats["furnitureTriangles"] = int(sum(len(a.faces) for a in additions))
    stats["furnitureAtlas"] = edit_stats.get("newAtlas")
    return out, stats
