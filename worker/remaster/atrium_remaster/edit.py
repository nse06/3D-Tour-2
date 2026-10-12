"""Changes to the model's shapes (docs/remaster.md §4.4, §4.5): triangles taken out, new ones put in.

New triangles either reuse texels the model already has (`Addition.uvs` in `Addition.atlas`: a wall cut
around a window keeps its painted wall, the window pushed back into the wall keeps its painted
window), or get texels of their own: those are unwrapped (xatlas, MIT) into a new atlas at the model's
texel size, start as the addition's color, and the skins (skins.py) learn them from the photos like
everything else.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .fill import pull_push, rasterize_uv
from .scene import Mesh


@dataclass
class Addition:
    vertices: np.ndarray  # (V, 3)
    faces: np.ndarray  # (F, 3), counter-clockwise seen from the side buyers see
    color: tuple[float, float, float] = (0.6, 0.6, 0.6)  # sRGB: new texels start as this
    uvs: np.ndarray | None = None  # (V, 2) in `atlas`: reuse the model's texels instead
    atlas: int | None = None
    name: str = ""


def oriented(vertices: np.ndarray, faces: np.ndarray, toward: np.ndarray) -> np.ndarray:
    """The faces, each wound so its normal points along `toward` ((3,) or (F, 3))."""
    a, b, c = (vertices[faces[:, k]] for k in range(3))
    n = np.cross(b - a, c - a)
    flip = (n * np.broadcast_to(toward, n.shape)).sum(-1) < 0
    out = faces.copy()
    out[flip] = out[flip][:, [0, 2, 1]]
    return out


def unwrap(additions: list[Addition], texel: float, max_side: int = 4096, padding: int = 2) -> tuple[list[np.ndarray], np.ndarray, int]:
    """xatlas charts for the additions in one square atlas at `texel` meters per texel (coarser if they
    wouldn't fit `max_side`): per addition its (V', 3) vertices' source indices are kept in `vmaps`."""
    import xatlas

    while True:
        atlas = xatlas.Atlas()
        for a in additions:
            atlas.add_mesh(np.ascontiguousarray(a.vertices, dtype=np.float32), np.ascontiguousarray(a.faces, dtype=np.uint32))
        pack = xatlas.PackOptions()
        pack.texels_per_unit = 1.0 / texel
        pack.padding = padding
        pack.bilinear = True
        pack.resolution = 0
        atlas.generate(xatlas.ChartOptions(), pack)
        side = max(atlas.width, atlas.height)
        if side <= max_side and atlas.atlas_count <= 1:
            break
        texel *= max(1.1, side / max_side)
    size = int(math.ceil(max(16, side) / 16) * 16)
    out = []
    for k in range(len(additions)):
        vmap, idx, uv = atlas[k]
        # xatlas's UVs are fractions of its (maybe oblong) atlas: in the square one, the same texels.
        uv = uv * np.array([atlas.width / size, atlas.height / size], np.float32)
        out.append((np.asarray(vmap, np.int64), np.asarray(idx, np.int64), uv.astype(np.float32)))
    return out, size, texel


def apply(mesh: Mesh, remove: np.ndarray, additions: list[Addition], texel: float | None = None, max_side: int = 4096) -> tuple[Mesh, dict]:
    """The mesh without the `remove`d triangles ((F,) bool), with the additions."""
    keep = ~np.asarray(remove, bool)
    vertices = [mesh.vertices]
    uvs = [mesh.uvs]
    faces = [mesh.faces[keep]]
    face_atlas = [mesh.face_atlas[keep]]
    face_color = [mesh.face_color[keep]]
    atlases = list(mesh.atlases)
    base = len(mesh.vertices)
    reuse = [a for a in additions if a.uvs is not None and a.atlas is not None]
    fresh = [a for a in additions if a.uvs is None or a.atlas is None]
    for a in reuse:
        vertices.append(a.vertices.astype(np.float32))
        uvs.append(a.uvs.astype(np.float32))
        faces.append(a.faces + base)
        face_atlas.append(np.full(len(a.faces), a.atlas, np.int64))
        face_color.append(np.tile(np.asarray(a.color, np.float32), (len(a.faces), 1)))
        base += len(a.vertices)
    stats = {"removedTriangles": int((~keep).sum()), "addedTriangles": int(sum(len(a.faces) for a in additions))}
    if fresh:
        if texel is None:
            sizes = mesh.texel_size()
            texel = float(np.median(sizes[np.isfinite(sizes)])) if np.isfinite(sizes).any() else 0.008
        charts, size, used = unwrap(fresh, texel, max_side)
        index = len(atlases)
        image = np.zeros((size, size, 3), np.float32)
        known = np.zeros((size, size), bool)
        for a, (vmap, idx, uv) in zip(fresh, charts):
            vertices.append(a.vertices[vmap].astype(np.float32))
            uvs.append(uv)
            faces.append(idx + base)
            face_atlas.append(np.full(len(idx), index, np.int64))
            face_color.append(np.tile(np.asarray(a.color, np.float32), (len(idx), 1)))
            covered = rasterize_uv(uv[idx], (size, size))
            image[covered] = np.asarray(a.color, np.float32)
            known |= covered
            base += len(vmap)
        atlases.append(pull_push(image, known) if known.any() else image)
        stats.update({"newAtlas": size, "newTexelMm": round(used * 1000, 2)})
    out = Mesh(
        vertices=np.concatenate(vertices).astype(np.float32),
        uvs=np.concatenate(uvs).astype(np.float32),
        faces=np.concatenate(faces).astype(np.int64),
        face_atlas=np.concatenate(face_atlas),
        face_color=np.concatenate(face_color).astype(np.float32),
        atlases=atlases,
        extras=mesh.extras,
    )
    return out, stats


def box(center: np.ndarray, axes: np.ndarray, size: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """An oriented box's 8 corners and 12 triangles, wound outward."""
    signs = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], np.float64)
    corners = center + (signs * size / 2) @ axes
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    faces = np.array([t for q in quads for t in ((q[0], q[1], q[2]), (q[0], q[2], q[3]))], np.int64)
    centroids = corners[faces].mean(1)
    return corners.astype(np.float32), oriented(corners, faces, centroids - center)
