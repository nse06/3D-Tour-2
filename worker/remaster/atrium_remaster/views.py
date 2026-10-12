"""Where each pixel of a view lands on the model: ray casting with Open3D (MIT; Embree underneath), so
every photo, every view where buyers walk and every panorama face gets, per pixel, the triangle it
sees, where on it (barycentric weights) and how far (camera depth).

Cameras are OpenCV's (x right, y down, looking along +z: atrium_photoreal.capture), pixel centers at
half-pixel offsets.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import open3d as o3d

from .scene import Mesh


@dataclass
class Hits:
    face: np.ndarray  # (H, W) int64: the triangle seen, -1 for none
    bary: np.ndarray  # (H, W, 2) float32: weights of the triangle's 2nd and 3rd vertices
    depth: np.ndarray  # (H, W) float32: along the camera's axis, inf for none

    @property
    def shape(self) -> tuple[int, int]:
        return self.face.shape

    @property
    def hit(self) -> np.ndarray:
        return self.face >= 0


class Caster:
    """Casts rays at a mesh (vertices (V, 3), faces (F, 3))."""

    def __init__(self, vertices: np.ndarray, faces: np.ndarray):
        self.scene = o3d.t.geometry.RaycastingScene()
        mesh = o3d.t.geometry.TriangleMesh()
        mesh.vertex.positions = o3d.core.Tensor(np.ascontiguousarray(vertices, dtype=np.float32))
        mesh.triangle.indices = o3d.core.Tensor(np.ascontiguousarray(faces, dtype=np.int32))
        self.scene.add_triangles(mesh)
        self.faces = len(faces)

    @classmethod
    def of(cls, mesh: Mesh) -> "Caster":
        return cls(mesh.vertices, mesh.faces)

    def rays(self, origins: np.ndarray, directions: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(N, 3) origins and directions: the distance along each direction (in its own length, inf for
        a miss), the triangle (-1) and the barycentric weights of its 2nd and 3rd vertices."""
        rays = np.concatenate([origins, directions], axis=1).astype(np.float32)
        out = self.scene.cast_rays(o3d.core.Tensor(np.ascontiguousarray(rays)))
        t = out["t_hit"].numpy()
        face = out["primitive_ids"].numpy().astype(np.int64)
        miss = ~np.isfinite(t) | (face >= self.faces) | (face < 0)
        face[miss] = -1
        t = np.where(miss, np.inf, t).astype(np.float32)
        return t, face, out["primitive_uvs"].numpy().astype(np.float32)

    def view(self, K: np.ndarray, camtoworld: np.ndarray, width: int, height: int) -> Hits:
        """What a pinhole camera (intrinsics K at width × height, OpenCV camera-to-world) sees."""
        u, v = np.meshgrid(np.arange(width, dtype=np.float64) + 0.5, np.arange(height, dtype=np.float64) + 0.5)
        d_cam = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1).reshape(-1, 3)
        d = d_cam @ camtoworld[:3, :3].T  # camera z = 1 along every ray: the distance is the depth
        o = np.broadcast_to(camtoworld[:3, 3], d.shape)
        t, face, bary = self.rays(o, d)
        return Hits(face.reshape(height, width), bary.reshape(height, width, 2), t.reshape(height, width))


def surface_uv(mesh: Mesh, hits: Hits) -> tuple[np.ndarray, np.ndarray]:
    """Per pixel, the atlas (-1: none or a flat triangle) and the texture coordinate seen (glTF's)."""
    face = np.where(hits.hit, hits.face, 0)
    tri = mesh.faces[face]
    w1, w2 = hits.bary[..., 0:1], hits.bary[..., 1:2]
    uv = (1 - w1 - w2) * mesh.uvs[tri[..., 0]] + w1 * mesh.uvs[tri[..., 1]] + w2 * mesh.uvs[tri[..., 2]]
    atlas = np.where(hits.hit, mesh.face_atlas[face], -1)
    return atlas, uv.astype(np.float32)


def surface_points(mesh: Mesh, hits: Hits) -> np.ndarray:
    """Per pixel, the point seen in the model's frame (NaN where nothing)."""
    face = np.where(hits.hit, hits.face, 0)
    tri = mesh.faces[face]
    w1, w2 = hits.bary[..., 0:1], hits.bary[..., 1:2]
    p = (1 - w1 - w2) * mesh.vertices[tri[..., 0]] + w1 * mesh.vertices[tri[..., 1]] + w2 * mesh.vertices[tri[..., 2]]
    return np.where(hits.hit[..., None], p, np.nan).astype(np.float32)


def sample(atlas: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """Bilinear lookup of an (S, S, C) atlas at glTF texture coordinates (..., 2), clamped at its edges."""
    h, w = atlas.shape[:2]
    x = np.clip(uv[..., 0] * w - 0.5, 0, w - 1)
    y = np.clip(uv[..., 1] * h - 0.5, 0, h - 1)
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    top = atlas[y0, x0] * (1 - fx) + atlas[y0, x1] * fx
    bottom = atlas[y1, x0] * (1 - fx) + atlas[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def render(mesh: Mesh, hits: Hits, background=(0.0, 0.0, 0.0)) -> np.ndarray:
    """The view as the viewer draws the model (unlit textures): (H, W, 3) float sRGB 0-1."""
    atlas, uv = surface_uv(mesh, hits)
    out = np.empty((*hits.shape, 3), np.float32)
    out[:] = background
    for a, image in enumerate(mesh.atlases):
        sel = atlas == a
        if sel.any():
            out[sel] = sample(image, uv[sel])
    flat = hits.hit & (atlas < 0)
    if flat.any():
        out[flat] = mesh.face_color[hits.face[flat]]
    return out
