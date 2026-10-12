"""Doors and windows set into their walls (docs/remaster.md §4.5).

The painted model keeps doors and windows on their wall's face, where the photos show them (only
doorways with a scanned room on both sides are cut through), so a door looks painted on as soon as a
buyer moves. With the room layout (build 13), each window and closed door is pushed back into the wall:
the wall is cut around it (keeping its painted texels: the cut wall maps to the same place in the same
atlas), the door or window itself sits `depth` back (still showing the texels painted for it), and the
reveals (sides, head and sill) are new surfaces the skins learn from the photos that see them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .edit import Addition, oriented
from .layout import Layout, Opening
from .scene import Mesh


@dataclass
class TrimConfig:
    depth: float = 0.1  # how far back a window or door sits (at most the wall's thickness)
    margin: float = 0.01  # the cut is this much inside the opening's rectangle
    plane_tolerance: float = 0.03  # a chart is the opening's wall if it lies within this of its plane
    kinds: tuple[str, ...] = ("window", "door")


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


def affine_uv(points2d: np.ndarray, uvs: np.ndarray) -> np.ndarray:
    """(3, 2) M with uv = [s, y, 1] @ M, fitted to a flat chart's vertices."""
    A = np.c_[points2d, np.ones(len(points2d))]
    M, *_ = np.linalg.lstsq(A, uvs, rcond=None)
    return M


def recess(mesh: Mesh, layout: Layout, cfg: TrimConfig = TrimConfig(), log=print) -> tuple[np.ndarray, list[Addition], dict]:
    """What to take out (the walls' charts that get cut) and put in (the cut walls, the openings set
    back, their reveals), for edit.apply."""
    import mapbox_earcut as earcut
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union

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
        faces = np.flatnonzero(chart == c)
        atlas = int(mesh.face_atlas[faces[0]])
        ref = openings[0]
        along = ref.along - n * (ref.along @ n)
        along /= np.linalg.norm(along)
        up = np.cross(n, along)
        if up[1] < 0:
            along, up = -along, -up
        origin = ref.center - n * ((ref.center - mesh.vertices[mesh.faces[faces[0], 0]]) @ n)  # on the face's plane
        to2d = lambda p: np.stack([(p - origin) @ along, (p - origin) @ up], -1)  # noqa: E731
        tri3 = mesh.vertices[mesh.faces[faces]].astype(np.float64)
        tri2 = to2d(tri3.reshape(-1, 3)).reshape(-1, 3, 2)
        M = affine_uv(tri2.reshape(-1, 2), mesh.uvs[mesh.faces[faces]].reshape(-1, 2).astype(np.float64))
        wall = unary_union([Polygon(t) for t in tri2 if Polygon(t).area > 1e-9]).buffer(0)
        holes = []
        for o in openings:
            cx, cy = to2d(o.center[None])[0]
            hw, hh = o.width / 2 - cfg.margin, o.height / 2 - cfg.margin
            rect = box(cx - hw, cy - hh, cx + hw, cy + hh).intersection(wall)
            if rect.area < 0.5 * (2 * hw) * (2 * hh):
                skipped += 1
                continue
            holes.append((o, rect))
        if not holes:
            continue
        cut = wall.difference(unary_union([r for _, r in holes]))
        pieces = [cut] if cut.geom_type == "Polygon" else list(getattr(cut, "geoms", []))
        verts2, tris = [], []
        for piece in pieces:
            if piece.geom_type != "Polygon" or piece.area < 1e-6:
                continue
            rings = [np.asarray(piece.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in piece.interiors]
            flat = np.concatenate(rings)
            ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
            idx = earcut.triangulate_float64(flat, ends).reshape(-1, 3)
            tris.append(idx + sum(len(v) for v in verts2))
            verts2.append(flat)
        if not tris:
            continue
        p2 = np.concatenate(verts2)
        p3 = origin + p2[:, :1] * along + p2[:, 1:] * up
        f = oriented(p3, np.concatenate(tris).astype(np.int64), n)
        uv = np.c_[p2, np.ones(len(p2))] @ M
        additions.append(Addition(p3.astype(np.float32), f, uvs=uv.astype(np.float32), atlas=atlas, name=f"wall-{c}"))
        remove[faces] = True
        color = tuple(float(v) for v in np.median(mesh.atlases[atlas].reshape(-1, 3)[:: max(1, mesh.atlases[atlas].size // 30000)], 0))
        for o, rect in holes:
            depth = cfg.depth
            x0, y0, x1, y1 = rect.bounds
            corners2 = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
            front = origin + corners2[:, :1] * along + corners2[:, 1:] * up
            back = front - n * depth
            # The opening itself, set back, with the texels painted for it.
            fb = oriented(back, np.array([[0, 1, 2], [0, 2, 3]]), n)
            additions.append(Addition(back.astype(np.float32), fb, uvs=(np.c_[corners2, np.ones(4)] @ M).astype(np.float32), atlas=atlas, name=f"{o.kind}-{o.id}"))
            # Its reveals: four strips joining the wall's face to it, facing into the opening.
            mid = (front.mean(0) + back.mean(0)) / 2
            for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
                quad = np.array([front[a], front[b], back[b], back[a]])
                inward = mid - quad.mean(0)
                inward -= n * (inward @ n)
                rf = oriented(quad, np.array([[0, 1, 2], [0, 2, 3]]), inward)
                additions.append(Addition(quad.astype(np.float32), rf, color=color, name=f"reveal-{o.id}"))
            recessed += 1
    stats = {"recessed": recessed, "recessSkipped": skipped}
    log(f"trim: {recessed} doors and windows set into their walls ({skipped} skipped)")
    return remove, additions, stats
