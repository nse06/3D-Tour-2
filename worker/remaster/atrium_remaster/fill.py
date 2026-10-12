"""Spots no photo saw, filled in (docs/remaster.md §3).

The phone fills texels no photo saw smoothly from their neighbors (pull-push), or with the typical color
of their kind of surface: a smudge where a wall's pattern, a floor's planks or a ceiling's texture
should go on. A flat surface's chart is a straight-on picture of it (walls, floors and ceilings are
packed that way, PhotoTexturing.swift), so an inpainting model can continue what the photos showed
into what they didn't. Curved charts (LiDAR furniture patches) keep the smooth fill: an image model
would draw across their folds.

The inpainter (`Inpainter`) takes images and masks of what to fill: LaMa on a GPU (models.py), or
`PullPush` without one (tests).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .scene import Mesh
from .views import Caster


class Inpainter(Protocol):
    name: str

    def __call__(self, images: list[np.ndarray], masks: list[np.ndarray]) -> list[np.ndarray]:
        """(H, W, 3) uint8 images and (H, W) bool masks (True: fill) in, the filled images out."""
        ...


@dataclass
class FillConfig:
    seen_below: float = 0.25  # texels with less photo weight than this count as unseen
    min_texels: int = 64  # charts with fewer unseen texels keep the smooth fill
    max_share: float = 0.7  # nor are charts filled where the photos saw less than 30%: too much to make up
    planar_mm: float = 10.0  # a chart is flat if its corners are within this of one plane
    margin: int = 16  # texels of seen surroundings sent along with each hole


def pull_push(image: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Fills unknown pixels of a float (H, W, C) image smoothly from the known ones (mean pyramid down,
    then back up)."""
    image = image.astype(np.float64)
    w = known.astype(np.float64)
    levels = [(image * w[..., None], w)]
    while min(levels[-1][1].shape) > 1:
        c, k = levels[-1]
        h, wd = k.shape
        h2, w2 = (h + 1) // 2, (wd + 1) // 2
        cp = np.zeros((h2 * 2, w2 * 2, c.shape[2]))
        kp = np.zeros((h2 * 2, w2 * 2))
        cp[:h, :wd], kp[:h, :wd] = c, k
        levels.append((cp.reshape(h2, 2, w2, 2, -1).sum((1, 3)), kp.reshape(h2, 2, w2, 2).sum((1, 3))))
    color, weight = levels[-1]
    filled = color / np.maximum(weight, 1e-9)[..., None]
    for c, k in reversed(levels[:-1]):
        h, wd = k.shape
        up = np.repeat(np.repeat(filled, 2, 0), 2, 1)[:h, :wd]
        own = c / np.maximum(k, 1e-9)[..., None]
        alpha = np.clip(k, 0, 1)[..., None]
        filled = alpha * own + (1 - alpha) * up
    return np.where(known[..., None], image, filled).astype(np.float32)


class PullPush:
    """A stand-in inpainter: the smooth fill."""

    name = "pull-push"

    def __call__(self, images: list[np.ndarray], masks: list[np.ndarray]) -> list[np.ndarray]:
        out = []
        for image, mask in zip(images, masks):
            filled = pull_push(image.astype(np.float32) / 255.0, ~mask)
            out.append((np.clip(filled, 0, 1) * 255 + 0.5).astype(np.uint8))
        return out


def rasterize_uv(uv: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """(H, W) bool: the texels whose centers fall in any of the (T, 3, 2) triangles (glTF UVs) at an
    atlas of `size` (H, W)."""
    h, w = size
    out = np.zeros((h, w), bool)
    pts = uv * np.array([w, h])
    for tri in pts:
        x0, y0 = np.floor(tri.min(0) - 0.5).astype(int)
        x1, y1 = np.ceil(tri.max(0) + 0.5).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
        if x1 <= x0 or y1 <= y0:
            continue
        xx, yy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        a, b, c = tri
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (xx - c[0]) + (c[0] - b[0]) * (yy - c[1])) / d
        l2 = ((c[1] - a[1]) * (xx - c[0]) + (a[0] - c[0]) * (yy - c[1])) / d
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l1 + l2 <= 1 + 1e-6)
        out[y0:y1, x0:x1] |= inside
    return out


def painted_from_photos(mesh: Mesh, seeds: np.ndarray, spacing: float) -> list[np.ndarray]:
    """Per atlas, (S, S) bool: the texels the phone painted from a photo. The phone's seeds (seeds.ply,
    PhotorealExport.swift) lie every `spacing` meters on exactly those surfaces, so each marks the
    texels within `spacing` of it."""
    out = [np.zeros(a.shape[:2], bool) for a in mesh.atlases]
    if not len(seeds) or not mesh.atlases:
        return out
    import open3d as o3d

    caster = Caster.of(mesh)
    found = caster.scene.compute_closest_points(o3d.core.Tensor(np.ascontiguousarray(seeds, dtype=np.float32)))
    face = found["primitive_ids"].numpy().astype(np.int64)
    bary = found["primitive_uvs"].numpy().astype(np.float64)
    ok = (face >= 0) & (face < len(mesh.faces))
    point = found["points"].numpy()
    ok &= np.linalg.norm(point - seeds, axis=1) < max(spacing, 0.01)
    face, bary = face[ok], bary[ok]
    tri = mesh.faces[face]
    uv = (1 - bary[:, :1] - bary[:, 1:]) * mesh.uvs[tri[:, 0]] + bary[:, :1] * mesh.uvs[tri[:, 1]] + bary[:, 1:] * mesh.uvs[tri[:, 2]]
    texel = mesh.texel_size()[face]
    atlas = mesh.face_atlas[face]
    for a, image in enumerate(out):
        sel = (atlas == a) & np.isfinite(texel)
        if not sel.any():
            continue
        h, w = image.shape
        x = np.clip((uv[sel, 0] * w).astype(np.int64), 0, w - 1)
        y = np.clip((uv[sel, 1] * h).astype(np.int64), 0, h - 1)
        image[y, x] = True
        # Each seed stands for the texels around it, out to the next seed.
        radius = int(np.ceil(np.median(spacing / texel[sel]))) if sel.any() else 0
        if radius > 0:
            from scipy import ndimage

            yy, xx = np.mgrid[-radius : radius + 1, -radius : radius + 1]
            out[a] = ndimage.binary_dilation(image, structure=(xx * xx + yy * yy) <= radius * radius)
    return out


def flat_charts(mesh: Mesh, chart: np.ndarray, planar_mm: float) -> list[int]:
    """Charts whose triangles lie in one plane (walls, floors, ceilings, a cabinet's faces)."""
    out = []
    for c in np.unique(chart):
        faces = np.flatnonzero(chart == c)
        if mesh.face_atlas[faces[0]] < 0:
            continue
        pts = mesh.vertices[np.unique(mesh.faces[faces])].astype(np.float64)
        if len(pts) < 3:
            continue
        center = pts.mean(0)
        _, s, vt = np.linalg.svd(pts - center, full_matrices=False)
        if np.abs((pts - center) @ vt[-1]).max() <= planar_mm / 1000:
            out.append(int(c))
    return out


def fill(
    mesh: Mesh, seen: list[np.ndarray], inpainter: Inpainter, cfg: FillConfig = FillConfig(), log=print, painted: list[np.ndarray] | None = None
) -> tuple[Mesh, dict]:
    """The mesh with what no photo saw on its flat charts filled in by the inpainter. `seen`: the photo
    weight per texel the skins counted (skins.coverage); `painted`: the texels the phone painted from a
    photo (painted_from_photos), which keep their colors even where the skins' stricter rules (no
    edges, no grazing views) counted nothing."""
    chart = mesh.charts()
    atlases = [a.copy() for a in mesh.atlases]
    jobs = []  # (atlas, y0, x0, image, hole)
    for c in flat_charts(mesh, chart, cfg.planar_mm):
        faces = np.flatnonzero(chart == c)
        a = int(mesh.face_atlas[faces[0]])
        atlas = atlases[a]
        h, w = atlas.shape[:2]
        uv = mesh.uvs[mesh.faces[faces]]
        lo = np.floor(uv.reshape(-1, 2).min(0) * [w, h]).astype(int)
        hi = np.ceil(uv.reshape(-1, 2).max(0) * [w, h]).astype(int)
        x0, y0 = max(lo[0] - cfg.margin, 0), max(lo[1] - cfg.margin, 0)
        x1, y1 = min(hi[0] + cfg.margin, w), min(hi[1] + cfg.margin, h)
        local = uv - np.array([x0 / w, y0 / h])
        inside = rasterize_uv(local * np.array([w / (x1 - x0), h / (y1 - y0)]), (y1 - y0, x1 - x0))
        weight = seen[a][y0:y1, x0:x1] if seen[a].shape == atlas.shape[:2] else np.zeros((y1 - y0, x1 - x0))
        keep = painted[a][y0:y1, x0:x1] if painted is not None and painted[a].shape == atlas.shape[:2] else np.zeros_like(inside)
        hole = inside & (weight < cfg.seen_below) & ~keep
        holes, area = int(hole.sum()), int(inside.sum())
        if holes < cfg.min_texels or area == 0 or holes > cfg.max_share * area:
            continue
        # Grow the hole by a texel so its rim (half seen, half made up) is redrawn too.
        grown = hole.copy()
        grown[1:] |= hole[:-1]
        grown[:-1] |= hole[1:]
        grown[:, 1:] |= hole[:, :-1]
        grown[:, :-1] |= hole[:, 1:]
        grown &= inside & ~keep
        crop = (np.clip(atlas[y0:y1, x0:x1], 0, 1) * 255 + 0.5).astype(np.uint8)
        jobs.append((a, y0, x0, crop, grown, inside))
    filled_texels = 0
    if jobs:
        results = inpainter([j[3] for j in jobs], [j[4] for j in jobs])
        for (a, y0, x0, crop, hole, inside), result in zip(jobs, results):
            if result.shape != crop.shape:
                raise RuntimeError(f"the inpainter answered {result.shape} for {crop.shape}")
            region = atlases[a][y0 : y0 + crop.shape[0], x0 : x0 + crop.shape[1]]
            region[hole] = result[hole].astype(np.float32) / 255.0
            filled_texels += int(hole.sum())
    log(f"fill: {len(jobs)} charts, {filled_texels:,} texels made up ({inpainter.name})")
    out = Mesh(mesh.vertices, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, atlases, mesh.extras)
    return out, {"filledCharts": len(jobs), "filledTexels": filled_texels, "inpainter": inpainter.name}
