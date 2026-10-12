"""Trim (docs/remaster.md §4.5): doors and windows set into their walls, and the baseboards, crown
moldings, door and window casings and cabinet doors the skins show, made into shapes.

The painted model keeps doors and windows on their wall's face, where the photos show them (only
doorways with a scanned room on both sides are cut through), so a door looks painted on as soon as a
buyer moves. With the room layout (build 13), each window and closed door is pushed back into the wall:
the wall is cut around it (keeping its painted texels: the cut wall maps to the same place in the same
atlas), the door or window itself sits `depth` back (still showing the texels painted for it), and the
reveals (sides, head and sill) are new surfaces the skins learn from the photos that see them.

The rest comes from the skins themselves: a band of even color along the bottom of a wall (a
baseboard), along its top (a crown molding) or around a door or window (its casing) becomes a slab
standing out of the wall, its face showing the band's texels; thin dark lines across a cabinet's front
(the gaps between its doors and drawers) become grooves, and a dark band along its bottom (the toe
kick) is set back. What the skins don't clearly show stays flat.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .edit import Addition, oriented
from .layout import Box, Layout, Opening
from .scene import Mesh

QUAD = np.array([[0, 1, 2], [0, 2, 3]])
UP = np.array([0.0, 1.0, 0.0])
LUMA = np.array([0.2126, 0.7152, 0.0722])


@dataclass
class BandConfig:
    """A band of even color along an edge of a face, `min_width` to `max_width` wide."""

    min_width: float
    max_width: float
    contrast: float = 0.07  # where it shows, it differs from the face beyond it by this much (sRGB, mean over channels)
    uniform: float = 0.05  # and is within this of its color all along the edge
    share: float = 0.5  # of the edge must show it (furniture hides some)
    skip: float = 0.012  # the first this much from the edge (the seam with the floor or the opening)
    gap: float = 0.008  # left out on both sides of the band's edge (soft in the skins)
    beyond: float = 0.06  # how much of the face past the band it's compared with
    darker: bool = False  # the band must be the darker side (a toe kick, in shadow)


@dataclass
class BoardConfig:
    baseboard: BandConfig = field(default_factory=lambda: BandConfig(0.06, 0.25))
    crown: BandConfig = field(default_factory=lambda: BandConfig(0.06, 0.2))
    step: float = 0.005  # band widths tried
    column: float = 0.01  # the wall is read in columns this far apart
    thickness: float = 0.012  # how far a baseboard stands out of the wall
    crown_thickness: float = 0.02
    min_length: float = 0.4
    floor_tolerance: float = 0.03  # a wall's bottom is on a floor (its top at a ceiling) within this
    wall_tolerance: float = 0.04  # a chart is on a layout wall within this of its inside face


@dataclass
class CasingConfig:
    band: BandConfig = field(default_factory=lambda: BandConfig(0.04, 0.12))
    step: float = 0.005
    column: float = 0.01
    thickness: float = 0.015
    agree: float = 0.02  # the sides' and head's widths agree within this
    kinds: tuple[str, ...] = ("door", "window")


@dataclass
class CabinetConfig:
    categories: tuple[str, ...] = ("storage",)
    step: float = 0.004  # the front is read on a grid this fine
    line: float = 0.012  # a gap is a dark line about this wide (or a texel and a half, if coarser)
    darker: float = 0.06  # darker than the front on both sides of it by this much (luminance)
    share: float = 0.7  # along this much of the front's height (a column's width, for drawers)
    edge: float = 0.08  # gaps at least this far from the front's sides, top and bottom
    groove: float = 0.006
    groove_depth: float = 0.015
    kick: BandConfig = field(default_factory=lambda: BandConfig(0.06, 0.16, darker=True))
    kick_depth: float = 0.06
    backed: float = 0.15  # a wall this close behind a box makes the opposite face its front


@dataclass
class TrimConfig:
    depth: float = 0.1  # how far back a window or door sits (at most the wall's thickness)
    margin: float = 0.01  # the cut is this much inside the opening's rectangle
    plane_tolerance: float = 0.03  # a chart is the opening's wall if it lies within this of its plane
    kinds: tuple[str, ...] = ("window", "door")
    recess: bool = True
    baseboards: bool = True
    crowns: bool = True
    casings: bool = True
    cabinets: bool = True
    board: BoardConfig = field(default_factory=BoardConfig)
    casing: CasingConfig = field(default_factory=CasingConfig)
    cabinet: CabinetConfig = field(default_factory=CabinetConfig)


# --- Flat faces in 2D ---------------------------------------------------------------------------


@dataclass
class Frame:
    """A flat chart's plane: (s, y) coordinates on it (along × up = normal, out of the face), the
    affine map from them to the chart's texels, and its outline (shapely)."""

    chart: int
    atlas: int
    faces: np.ndarray
    origin: np.ndarray
    along: np.ndarray
    up: np.ndarray
    normal: np.ndarray
    M: np.ndarray | None = None
    outline: object = None

    def to2d(self, p: np.ndarray) -> np.ndarray:
        d = np.asarray(p, np.float64) - self.origin
        return np.stack([d @ self.along, d @ self.up], -1)

    def to3d(self, q: np.ndarray, out: float = 0.0) -> np.ndarray:
        q = np.asarray(q, np.float64)
        return self.origin + q[:, :1] * self.along + q[:, 1:] * self.up + out * self.normal

    def uv(self, q: np.ndarray) -> np.ndarray:
        q = np.asarray(q, np.float64)
        return (np.c_[q, np.ones(len(q))] @ self.M).astype(np.float32)


def affine_uv(points2d: np.ndarray, uvs: np.ndarray) -> np.ndarray:
    """(3, 2) M with uv = [s, y, 1] @ M, fitted to a flat chart's vertices."""
    A = np.c_[points2d, np.ones(len(points2d))]
    M, *_ = np.linalg.lstsq(A, uvs, rcond=None)
    return M


def frame_of(mesh: Mesh, chart: np.ndarray, c: int, normal: np.ndarray, along: np.ndarray, origin: np.ndarray) -> Frame:
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    faces = np.flatnonzero(chart == c)
    f = Frame(int(c), int(mesh.face_atlas[faces[0]]), faces, np.asarray(origin, np.float64), along, np.cross(normal, along), normal)
    tri2 = f.to2d(mesh.vertices[mesh.faces[faces]].reshape(-1, 3)).reshape(-1, 3, 2)
    f.M = affine_uv(tri2.reshape(-1, 2), mesh.uvs[mesh.faces[faces]].reshape(-1, 2).astype(np.float64))
    f.outline = unary_union([Polygon(t) for t in tri2 if Polygon(t).area > 1e-9]).buffer(0)
    return f


def upright_frame(mesh: Mesh, chart: np.ndarray, c: int, normal: np.ndarray) -> Frame:
    """The frame of a vertical face, y being the height above the model's zero."""
    n = np.array([normal[0], 0.0, normal[2]], np.float64)
    n /= np.linalg.norm(n)
    faces = np.flatnonzero(chart == c)
    d = float(mesh.vertices[mesh.faces[faces]].reshape(-1, 3).astype(np.float64).mean(0) @ n)
    return frame_of(mesh, chart, c, n, np.cross(UP, n), n * d)


def chart_normal(mesh: Mesh, faces: np.ndarray) -> np.ndarray | None:
    n = (mesh.face_normals[faces] * mesh.face_areas[faces, None]).sum(0)
    length = float(np.linalg.norm(n))
    return n / length if length > 1e-9 else None


def read(mesh: Mesh, frame: Frame, s, y) -> np.ndarray:
    """The skin's colors at frame points (s, y) (broadcast together), NaN off the face."""
    import shapely

    from .views import sample

    s, y = np.broadcast_arrays(np.asarray(s, np.float64), np.asarray(y, np.float64))
    inside = shapely.contains_xy(frame.outline, s, y)
    colors = sample(mesh.atlases[frame.atlas], frame.uv(np.stack([s.ravel(), y.ravel()], -1))).reshape(*s.shape, 3)
    return np.where(inside[..., None], colors, np.nan)


def polygons(geom) -> list:
    if geom.geom_type == "Polygon":
        return [geom] if geom.area > 1e-6 else []
    return [g for g in getattr(geom, "geoms", []) if g.geom_type == "Polygon" and g.area > 1e-6]


def triangulate(geom) -> tuple[np.ndarray, np.ndarray]:
    """(V, 2) points and (T, 3) triangles of a shapely polygon or multipolygon (earcut)."""
    import mapbox_earcut as earcut

    verts, tris, base = [], [], 0
    for piece in polygons(geom):
        rings = [np.asarray(piece.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in piece.interiors]
        flat = np.concatenate(rings)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        tris.append(earcut.triangulate_float64(flat, ends).reshape(-1, 3).astype(np.int64) + base)
        verts.append(flat)
        base += len(flat)
    if not tris:
        return np.zeros((0, 2)), np.zeros((0, 3), np.int64)
    return np.concatenate(verts), np.concatenate(tris)


# --- Holes and slabs ------------------------------------------------------------------------------


@dataclass
class Hole:
    shape: object  # shapely, in the frame's (s, y)
    depth: float
    color: tuple[float, float, float]  # its sides' texels start as this
    bottom_side: bool = True  # False: no side along its bottom (a toe kick: the floor runs under it)


def inset(frame: Frame, holes: list[Hole], name: str) -> list[Addition]:
    """The face with its holes pushed back: what's left of the face and the holes' backs (both keep
    their texels) and the holes' sides (new texels), facing into the holes. Holes of one depth merge."""
    from shapely.geometry.polygon import orient
    from shapely.ops import unary_union

    groups: dict[float, list[Hole]] = {}
    for h in holes:
        shape = h.shape.intersection(frame.outline)
        if shape.area > 1e-6:
            groups.setdefault(round(h.depth, 4), []).append(Hole(shape, h.depth, h.color, h.bottom_side))
    if not groups:
        return []
    out = []
    p2, t = triangulate(frame.outline.difference(unary_union([h.shape for hs in groups.values() for h in hs])))
    if len(t):
        p3 = frame.to3d(p2)
        out.append(Addition(p3.astype(np.float32), oriented(p3, t, frame.normal), uvs=frame.uv(p2), atlas=frame.atlas, name=f"{name}-face"))
    for depth, hs in groups.items():
        merged = unary_union([h.shape for h in hs])
        p2, t = triangulate(merged)
        if not len(t):
            continue
        back = frame.to3d(p2, -depth)
        out.append(Addition(back.astype(np.float32), oriented(back, t, frame.normal), uvs=frame.uv(p2), atlas=frame.atlas, name=f"{name}-back"))
        open_below = [h.shape.bounds[1] for h in hs if not h.bottom_side]
        verts, tris = [], []
        for piece in polygons(merged):
            piece = orient(piece, 1.0)  # the hole is on each edge's left
            for ring in [piece.exterior, *piece.interiors]:
                q = np.asarray(ring.coords)
                for a, b in zip(q[:-1], q[1:]):
                    d = b - a
                    if math.hypot(*d) < 1e-6:
                        continue
                    if abs(d[1]) < 1e-6 and d[0] > 0 and any(abs(a[1] - y) < 1e-4 for y in open_below):
                        continue
                    inward = -d[1] * frame.along + d[0] * frame.up
                    quad = np.concatenate([frame.to3d(np.array([a, b])), frame.to3d(np.array([b, a]), -depth)])
                    tris.append(oriented(quad, QUAD, inward) + 4 * len(verts))
                    verts.append(quad)
        if verts:
            out.append(Addition(np.concatenate(verts).astype(np.float32), np.concatenate(tris), color=hs[0].color, name=f"{name}-sides"))
    return out


SIDES = {"bottom": (0, 1), "right": (1, 2), "top": (2, 3), "left": (3, 0)}


def slab(frame: Frame, s0: float, y0: float, s1: float, y1: float, thickness: float, color, name: str, sides=("bottom", "right", "top", "left")) -> list[Addition]:
    """A board standing `thickness` out of the face over [s0, s1] × [y0, y1]: its front shows the
    face's texels there, its `sides` are new."""
    q = np.array([[s0, y0], [s1, y0], [s1, y1], [s0, y1]])
    back, front = frame.to3d(q), frame.to3d(q, thickness)
    out = [Addition(front.astype(np.float32), oriented(front, QUAD, frame.normal), uvs=frame.uv(q), atlas=frame.atlas, name=name)]
    verts, tris = [], []
    middle = front.mean(0)
    for side in sides:
        a, b = SIDES[side]
        quad = np.array([back[a], back[b], front[b], front[a]])
        outward = quad.mean(0) - middle
        outward -= frame.normal * (outward @ frame.normal)
        tris.append(oriented(quad, QUAD, outward) + 4 * len(verts))
        verts.append(quad)
    if verts:
        out.append(Addition(np.concatenate(verts).astype(np.float32), np.concatenate(tris), color=tuple(float(v) for v in color), name=f"{name}-sides"))
    return out


# --- Bands of even color --------------------------------------------------------------------------


def band(colors: np.ndarray, depths: np.ndarray, cfg: BandConfig) -> tuple[float, np.ndarray, np.ndarray] | None:
    """A band along an edge in `colors` ((depths, positions, 3) read `depths` in from the edge, NaN
    off the face): its width, which positions show it, and its color. A position shows it when the
    band there differs from the face beyond it and is the band's color, both all along the edge and
    from its edge to its far side (a checked wall isn't a band, nor a shadow fading out)."""
    usable = ~np.isnan(colors[depths <= cfg.max_width + cfg.gap + cfg.beyond]).any(axis=(0, 2))
    if usable.sum() < 8:
        return None
    best = None
    for w in depths[(depths >= cfg.min_width - 1e-9) & (depths <= cfg.max_width + 1e-9)]:
        inner = colors[(depths > cfg.skip) & (depths < w - cfg.gap)][:, usable]
        outer = colors[(depths > w + cfg.gap) & (depths < w + cfg.beyond)][:, usable]
        if len(inner) < 3 or len(outer) < 3:
            continue
        here, there = inner.mean(0), outer.mean(0)  # (positions, 3)
        color = np.median(here, 0)
        differ = np.abs(here - there).mean(-1)
        shows = (differ >= cfg.contrast) & (np.abs(here - color).mean(-1) <= cfg.uniform)
        # Even from its edge to its far side: a plateau, not a blurred line or a shadow fading out.
        shows &= np.abs(inner - color).mean(-1).max(0) <= np.minimum(2 * cfg.uniform, 0.5 * differ)
        if cfg.darker:
            shows &= here @ LUMA < there @ LUMA - cfg.contrast
        if shows.mean() < cfg.share:
            continue
        contrast = float(np.median(differ[shows]))
        if best is None or contrast > best[0]:
            full = np.zeros(len(usable), bool)
            full[usable] = shows
            best = (contrast, float(w), full, color)
    return None if best is None else best[1:]


# --- Doors and windows set into their walls --------------------------------------------------------


def wall_chart(mesh: Mesh, chart: np.ndarray, opening: Opening, cfg: TrimConfig) -> tuple[int, np.ndarray] | None:
    """The chart of the wall face the opening is on (its normal into the room), and that normal."""
    normals = mesh.face_normals
    centroids = mesh.vertices[mesh.faces].mean(1)
    best, best_area = None, 0.0
    areas = mesh.face_areas
    for sign in (1.0, -1.0):
        n = opening.normal * sign
        on_plane = np.abs((centroids - opening.center) @ n) < cfg.plane_tolerance
        facing = normals @ n > math.cos(math.radians(10))
        sel = on_plane & facing & (mesh.face_atlas >= 0)
        if not sel.any():
            continue
        for c in np.unique(chart[sel]):
            faces = np.flatnonzero((chart == c) & sel)
            # The chart must reach over the opening's middle (not a cabinet's face in the same plane).
            pts = mesh.vertices[mesh.faces[faces]].reshape(-1, 3) - opening.center
            s, y = pts @ opening.along, pts[:, 1]
            if not (s.min() < -opening.width / 2 + 0.05 and s.max() > opening.width / 2 - 0.05 and y.min() < 0 < y.max()):
                continue
            area = float(areas[faces].sum())
            if area > best_area:
                best, best_area = (int(c), n), area
    return best


def recess(mesh: Mesh, layout: Layout, cfg: TrimConfig = TrimConfig(), log=print) -> tuple[np.ndarray, list[Addition], dict]:
    """What to take out (the walls' charts that get cut) and put in (the cut walls, the openings set
    back, their reveals), for edit.apply."""
    from shapely.geometry import box

    chart = mesh.charts()
    remove = np.zeros(len(mesh.faces), bool)
    additions: list[Addition] = []
    # Openings by the wall chart they're on: a wall with two windows is cut once, around both.
    by_chart: dict[int, tuple[np.ndarray, list[Opening]]] = {}
    skipped = 0
    for o in layout.openings:
        if o.kind not in cfg.kinds or o.open:
            continue
        found = wall_chart(mesh, chart, o, cfg)
        if found is None:
            skipped += 1
            continue
        c, n = found
        by_chart.setdefault(c, (n, []))[1].append(o)
    recessed = 0
    for c, (n, openings) in by_chart.items():
        frame = upright_frame(mesh, chart, c, n)
        bottom = frame.outline.bounds[1]
        atlas = mesh.atlases[frame.atlas]
        color = tuple(float(v) for v in np.median(atlas.reshape(-1, 3)[:: max(1, atlas.size // 30000)], 0))
        holes = []
        for o in openings:
            cx, cy = frame.to2d(o.center[None])[0]
            hw, hh = o.width / 2 - cfg.margin, o.height / 2 - cfg.margin
            lo = cy - hh
            if o.kind == "door" and lo - bottom < 0.05:
                lo = bottom - 0.01  # a door standing on the floor is cut down to the wall's bottom
            rect = box(cx - hw, lo, cx + hw, cy + hh).intersection(frame.outline)
            if rect.area < 0.5 * (2 * hw) * (2 * hh):
                skipped += 1
                continue
            holes.append(Hole(rect, cfg.depth, color))
        if not holes:
            continue
        additions += inset(frame, holes, f"wall-{c}")  # the cut wall (-face), the openings (-back), their reveals (-sides)
        remove[frame.faces] = True
        recessed += len(holes)
    stats = {"recessed": recessed, "recessSkipped": skipped}
    log(f"trim: {recessed} doors and windows set into their walls ({skipped} skipped)")
    return remove, additions, stats


# --- Baseboards and crown moldings ----------------------------------------------------------------


def level_heights(mesh: Mesh, chart: np.ndarray, facing: float, min_area: float = 1.0) -> np.ndarray:
    """Heights of the large level charts facing up (`facing` 1: floors) or down (-1: ceilings)."""
    normals, areas = mesh.face_normals, mesh.face_areas
    sel = (normals[:, 1] * facing > 0.95) & (mesh.face_atlas >= 0)
    out = []
    for c in np.unique(chart[sel]):
        faces = np.flatnonzero((chart == c) & sel)
        if areas[faces].sum() >= min_area:
            out.append(float(np.average(mesh.vertices[mesh.faces[faces]][..., 1].mean(1), weights=areas[faces])))
    return np.array(sorted(out))


def wall_faces(mesh: Mesh, chart: np.ndarray, layout: Layout, cfg: BoardConfig) -> list[tuple[int, np.ndarray, float | None, float | None]]:
    """The walls' faces: flat vertical charts at least 1.5 m tall (on one of the layout's walls, when
    there is a layout), with their normals into the room and the floor and ceiling heights they meet
    (None where they don't reach one)."""
    from .fill import flat_charts

    floors, ceilings = level_heights(mesh, chart, 1.0), level_heights(mesh, chart, -1.0)
    out = []
    for c in flat_charts(mesh, chart, 10.0):
        faces = np.flatnonzero(chart == c)
        n = chart_normal(mesh, faces)
        if n is None or abs(n[1]) > 0.1:
            continue
        pts = mesh.vertices[mesh.faces[faces]].reshape(-1, 3).astype(np.float64)
        bottom, top = float(pts[:, 1].min()), float(pts[:, 1].max())
        if top - bottom < 1.5:
            continue
        if layout.walls:
            on = [w for w in layout.walls if np.abs((pts[:, [0, 2]] - w.a) @ w.inside).max() < cfg.wall_tolerance and float(n[[0, 2]] @ w.inside) > 0.95]
            if not on:
                continue
            lows, highs = np.array([w.y0 for w in on]), np.array([w.y1 for w in on])
        else:
            lows, highs = floors, ceilings
        near = lambda levels, y: float(levels[np.argmin(np.abs(levels - y))]) if len(levels) and np.abs(levels - y).min() <= cfg.floor_tolerance else None  # noqa: E731
        floor, ceiling = near(lows, bottom), near(highs, top)
        if floor is not None or ceiling is not None:
            out.append((int(c), n, floor, ceiling))
    return out


def boards(mesh: Mesh, layout: Layout, cfg: BoardConfig = BoardConfig(), baseboards: bool = True, crowns: bool = True, log=print) -> tuple[list[Addition], dict]:
    """Baseboards (and crown moldings) where the wall skins show one: a band along the bottom (top) of
    a wall, of an even color that differs from the wall beside it. Each becomes a slab standing out of
    the wall, its face showing the band's texels, its top (bottom) and ends new. Run it on the walls as
    cut for their doors (recess): a baseboard stops at a door."""
    from shapely.geometry import LineString

    chart = mesh.charts()
    additions: list[Addition] = []
    found = {"baseboards": 0, "crowns": 0}
    for c, n, floor, ceiling in wall_faces(mesh, chart, layout, cfg):
        frame = upright_frame(mesh, chart, c, n)
        s_lo, _, s_hi, _ = frame.outline.bounds
        if s_hi - s_lo < cfg.min_length:
            continue
        s = np.arange(s_lo + cfg.column / 2, s_hi, cfg.column)
        for kind, level, sign, bcfg, thickness, sides in (
            ("baseboards", floor, 1.0, cfg.baseboard, cfg.thickness, ("left", "top", "right")),
            ("crowns", ceiling, -1.0, cfg.crown, cfg.crown_thickness, ("left", "bottom", "right")),
        ):
            if level is None or not (baseboards if kind == "baseboards" else crowns):
                continue
            depths = np.arange(cfg.step, bcfg.max_width + bcfg.gap + bcfg.beyond + cfg.step, cfg.step)
            colors = read(mesh, frame, s[None, :], level + sign * depths[:, None])
            found_band = band(colors, depths, bcfg)
            if found_band is None:
                continue
            h, shows, color = found_band
            usable = ~np.isnan(colors).any(axis=(0, 2))
            line = LineString([(s_lo - 1, level + sign * h / 2), (s_hi + 1, level + sign * h / 2)]).intersection(frame.outline)
            for seg in [line] if line.geom_type == "LineString" else list(getattr(line, "geoms", [])):
                if seg.geom_type != "LineString" or seg.length < cfg.min_length:
                    continue
                xs = [x for x, _ in seg.coords]
                s0, s1 = min(xs), max(xs)
                within = (s >= s0) & (s <= s1) & usable
                if not within.any() or shows[within].mean() < bcfg.share:
                    continue
                y0, y1 = sorted((level, level + sign * h))
                additions += slab(frame, s0, y0, s1, y1, thickness, color, f"{kind[:-1]}-{c}", sides)
                found[kind] += 1
    log(f"trim: {found['baseboards']} baseboards, {found['crowns']} crown moldings")
    return additions, found


# --- Door and window casings ----------------------------------------------------------------------


def casings(mesh: Mesh, layout: Layout, cfg: CasingConfig = CasingConfig(), log=print) -> tuple[list[Addition], dict]:
    """Casings where the wall skins show one: a band of even color, as wide on both sides of a door or
    window as over it (and under a window, if there's an apron), differing from the wall beyond it.
    Each piece becomes a slab standing out of the wall, showing its texels."""
    chart = mesh.charts()
    additions: list[Addition] = []
    found = 0
    for o in layout.openings:
        if o.kind not in cfg.kinds:
            continue
        hit = wall_chart(mesh, chart, o, TrimConfig())
        if hit is None:
            continue
        c, n = hit
        frame = upright_frame(mesh, chart, c, n)
        sc = float(frame.to2d(o.center[None])[0, 0])
        x0, x1 = sc - o.width / 2, sc + o.width / 2
        y0, y1 = float(o.center[1]) - o.height / 2, float(o.center[1]) + o.height / 2
        bottom = frame.outline.bounds[1]
        door = o.kind == "door"
        depths = np.arange(cfg.step, cfg.band.max_width + cfg.band.gap + cfg.band.beyond + cfg.step, cfg.step)
        ys = np.arange(max(y0, bottom) + 0.3 if door else y0 + 0.02, y1 - 0.02, cfg.column)  # above a baseboard
        xs = np.arange(x0 + 0.02, x1 - 0.02, cfg.column)
        edges = {
            "left": read(mesh, frame, x0 - depths[:, None], ys[None, :]),
            "right": read(mesh, frame, x1 + depths[:, None], ys[None, :]),
            "head": read(mesh, frame, xs[None, :], y1 + depths[:, None]),
        }
        if not door:
            edges["sill"] = read(mesh, frame, xs[None, :], y0 - depths[:, None])
        bands = {k: band(v, depths, cfg.band) for k, v in edges.items() if v.shape[1] >= 8}
        around = [bands.get(k) for k in ("left", "right", "head")]
        if any(b is None for b in around):
            continue
        widths, colors = np.array([b[0] for b in around]), np.array([b[2] for b in around])
        w, color = float(np.median(widths)), np.median(colors, 0)
        if np.abs(widths - w).max() > cfg.agree or np.abs(colors - color).mean(-1).max() > 0.08:
            continue
        sill = bands.get("sill")
        if sill is not None and (abs(sill[0] - w) > cfg.agree or np.abs(sill[2] - color).mean() > 0.08):
            sill = None
        lo = bottom if door else (y0 - w if sill is not None else y0)
        name = f"casing-{o.id}"
        legs = ("left", "right", "top") if door else ("left", "right", "top", "bottom")
        additions += slab(frame, x0 - w, lo, x0, y1 + w, cfg.thickness, color, name, legs)
        additions += slab(frame, x1, lo, x1 + w, y1 + w, cfg.thickness, color, name, legs)
        additions += slab(frame, x0, y1, x1, y1 + w, cfg.thickness, color, name, ("top", "bottom"))
        if sill is not None:
            additions += slab(frame, x0, y0 - w, x1, y0, cfg.thickness, color, name, ("top", "bottom"))
        found += 1
    log(f"trim: {found} door and window casings")
    return additions, {"casings": found}


# --- Cabinet doors --------------------------------------------------------------------------------


def lines(L: np.ndarray, k: int, darker: float, share: float) -> tuple[np.ndarray, np.ndarray]:
    """Thin dark lines down the columns of L ((rows, cols) luminance, NaN off the face): per column,
    the share of rows where it's `darker` than both neighbors `k` columns away, and how much darker
    on average."""
    left, right = np.full_like(L, np.nan), np.full_like(L, np.nan)
    left[:, k:], right[:, :-k] = L[:, :-k], L[:, k:]
    D = np.minimum(left, right) - L
    valid = ~np.isnan(D)
    counted = np.maximum(valid.sum(0), 1)
    score = np.where(valid.sum(0) >= 0.5 * len(L), ((D >= darker) & valid).sum(0) / counted, 0.0)
    return score, np.where(valid, D, 0).sum(0) / counted


def peaks(score: np.ndarray, depth: np.ndarray, positions: np.ndarray, share: float, lo: float, hi: float) -> list[float]:
    """The middle (darkest point) of each run of positions scoring at least `share`, inside [lo, hi]."""
    out = []
    run: list[int] = []
    for i in range(len(score) + 1):
        if i < len(score) and score[i] >= share:
            run.append(i)
            continue
        if run:
            best = run[int(np.argmax(depth[run]))]
            if lo <= positions[best] <= hi:
                out.append(float(positions[best]))
            run = []
    return out


def chart_centers(mesh: Mesh, chart: np.ndarray) -> np.ndarray:
    """(charts, 3) each chart's center (area weighted): a chart wholly in a box has its center in it."""
    areas = mesh.face_areas
    middles = mesh.vertices[mesh.faces].astype(np.float64).mean(1)
    weight = np.maximum(np.bincount(chart, weights=areas), 1e-12)
    return np.stack([np.bincount(chart, weights=areas * middles[:, k]) for k in range(3)], 1) / weight[:, None]


def box_fronts(mesh: Mesh, chart: np.ndarray, flat: list[int], centers: np.ndarray, box: Box, layout: Layout, cfg: CabinetConfig) -> list[tuple[int, np.ndarray]]:
    """The box's vertical faces that face the room: the ones opposite a wall it stands against (all
    of them if it stands free). `centers`: chart_centers, to look only at the flat charts in the box."""
    faces_in = []
    flat = np.asarray(flat, np.int64)
    for c in flat[box.contains(centers[flat], 0.03)] if len(flat) else []:
        faces = np.flatnonzero(chart == c)
        if not box.contains(mesh.vertices[mesh.faces[faces]].reshape(-1, 3), 0.03).all():
            continue
        n = chart_normal(mesh, faces)
        if n is None or abs(n[1]) > 0.1 or mesh.face_areas[faces].sum() < 0.05:
            continue
        faces_in.append((int(c), n))
    fronts = []
    for axis, half in ((box.axes[0], box.size[0] / 2), (box.axes[2], box.size[2] / 2)):
        for d in (axis, -axis):
            d2 = np.array([d[0], d[2]]) / max(1e-9, float(np.hypot(d[0], d[2])))
            back = (box.center - d * half)[[0, 2]]
            for w in layout.walls:
                t = float((back - w.a) @ w.along)
                if float(d2 @ w.inside) > 0.9 and abs(float((back - w.a) @ w.inside)) < cfg.backed and -0.2 < t < w.length + 0.2:
                    fronts.append(d)
                    break
    if not fronts:
        return faces_in
    return [(c, n) for c, n in faces_in if any(float(n @ d) > 0.9 for d in fronts)]


def cabinets(mesh: Mesh, layout: Layout, cfg: CabinetConfig = CabinetConfig(), log=print) -> tuple[np.ndarray, list[Addition], dict]:
    """Cabinet fronts as the skins show them: the gaps between doors and drawers (thin dark lines,
    full height between doors, a column's width between drawers) become grooves, a dark band along the
    bottom (the toe kick) is set back. What to take out (the fronts) and put in, for edit.apply."""
    from shapely.geometry import box as rect

    from .fill import flat_charts

    chart = mesh.charts()
    flat = flat_charts(mesh, chart, 10.0)
    centers = chart_centers(mesh, chart)
    texels = mesh.texel_size()
    remove = np.zeros(len(mesh.faces), bool)
    additions: list[Addition] = []
    grooves = kicks = 0
    for b in layout.objects:
        if b.category not in cfg.categories or b.lidar:
            continue
        for c, n in box_fronts(mesh, chart, flat, centers, b, layout, cfg):
            frame = upright_frame(mesh, chart, c, n)
            s_lo, y_lo, s_hi, y_hi = frame.outline.bounds
            if s_hi - s_lo < 0.2 or y_hi - y_lo < 0.2:
                continue
            holes: list[Hole] = []
            s = np.arange(s_lo + cfg.step / 2, s_hi, cfg.step)
            depths = np.arange(cfg.step, cfg.kick.max_width + cfg.kick.gap + cfg.kick.beyond + cfg.step, cfg.step)
            kick = band(read(mesh, frame, s[None, :], y_lo + depths[:, None]), depths, cfg.kick)
            base = y_lo
            if kick is not None:
                h, _, color = kick
                holes.append(Hole(rect(s_lo - 1, y_lo - 1, s_hi + 1, y_lo + h), cfg.kick_depth, tuple(map(float, color)), bottom_side=False))
                base = y_lo + h
                kicks += 1
            y = np.arange(base + 0.03, y_hi - 0.03, cfg.step)
            if len(y) < 8:
                continue
            colors = read(mesh, frame, s[None, :], y[:, None])
            L = colors @ LUMA
            texel = float(np.median(texels[frame.faces]))
            k = max(1, int(round(max(cfg.line, 1.5 * texel) / cfg.step)))
            score, depth = lines(L, k, cfg.darker, cfg.share)
            vertical = peaks(score, depth, s, cfg.share, s_lo + cfg.edge, s_hi - cfg.edge)
            dark = []
            for g in vertical:
                holes.append(Hole(rect(g - cfg.groove / 2, base, g + cfg.groove / 2, y_hi + 1), cfg.groove_depth, (0.1, 0.1, 0.1)))
                dark.append(colors[:, np.argmin(np.abs(s - g))])
            bounds = [s_lo, *vertical, s_hi]
            for a, z in zip(bounds[:-1], bounds[1:]):
                cols = (s > a + 0.03) & (s < z - 0.03)
                if cols.sum() < 8:
                    continue
                score_h, depth_h = lines(L[:, cols].T, k, cfg.darker, cfg.share)
                for g in peaks(score_h, depth_h, y, cfg.share, base + cfg.edge, y_hi - cfg.edge):
                    holes.append(Hole(rect(a, g - cfg.groove / 2, z, g + cfg.groove / 2), cfg.groove_depth, (0.1, 0.1, 0.1)))
                    dark.append(colors[np.argmin(np.abs(y - g)), cols])
            if dark:
                gap_color = tuple(float(v) for v in np.nanmedian(np.concatenate(dark), 0))
                for h in holes:
                    if h.depth == cfg.groove_depth:
                        h.color = gap_color
            if not holes:
                continue
            grooves += sum(h.depth == cfg.groove_depth for h in holes)
            additions += inset(frame, holes, f"cabinet-{b.id}")
            remove[frame.faces] = True
    log(f"trim: {grooves} gaps between cabinet doors and drawers, {kicks} toe kicks")
    return remove, additions, {"cabinetGaps": grooves, "toeKicks": kicks}


# --- All of it ------------------------------------------------------------------------------------


def run(mesh: Mesh, layout: Layout, cfg: TrimConfig = TrimConfig(), log=print) -> tuple[Mesh, dict]:
    """All of the trim as one edit of the mesh (one new atlas for the new surfaces): doors and windows
    set back first, then what the skins show on the walls as cut (a baseboard stops at a door)."""
    from .edit import apply

    stats: dict = {}
    remove = np.zeros(len(mesh.faces), bool)
    additions: list[Addition] = []
    if cfg.recess and layout.openings:
        remove, additions, s = recess(mesh, layout, cfg, log)
        stats.update(s)
    fresh = [a for a in additions if a.uvs is None]
    cut, _ = apply(mesh, remove, [a for a in additions if a.uvs is not None])
    remove_cut = np.zeros(len(cut.faces), bool)
    more: list[Addition] = []
    if cfg.baseboards or cfg.crowns:
        a, s = boards(cut, layout, cfg.board, baseboards=cfg.baseboards, crowns=cfg.crowns, log=log)
        more += a
        stats.update(s)
    if cfg.casings and layout.openings:
        a, s = casings(cut, layout, cfg.casing, log)
        more += a
        stats.update(s)
    if cfg.cabinets and layout.objects:
        r, a, s = cabinets(cut, layout, cfg.cabinet, log)
        remove_cut |= r
        more += a
        stats.update(s)
    if not (remove.any() or additions or more):
        return mesh, stats
    out, edit_stats = apply(cut, remove_cut, more + fresh)
    stats["removedTriangles"] = int(remove.sum() + remove_cut.sum())
    stats["addedTriangles"] = int(sum(len(a.faces) for a in additions + more))
    stats.update({k: v for k, v in edit_stats.items() if k.startswith("new")})
    return out, stats
