"""The painted model as the remaster works on it: every textured triangle in one list, with the atlas
it's painted in, and the atlases as float images.

The phone's photo model (docs/iphone-capture.md §2.4) packs surfaces into *charts*: a wall's inside
face, a room's floor or ceiling, a piece of furniture's face or a LiDAR patch, each a rectangle of an
atlas at about the same texel size (8 mm, coarser in big homes). The GLB keeps one primitive per atlas
and duplicates vertices along chart edges, so a chart is a connected group of triangles sharing
vertices; `charts()` finds them again.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from functools import cached_property

import numpy as np
from PIL import Image
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from . import glb


@dataclass
class Mesh:
    vertices: np.ndarray  # (V, 3) float32, the model's frame (meters, y up)
    uvs: np.ndarray  # (V, 2) float32, glTF's (v down from the atlas's top)
    faces: np.ndarray  # (F, 3) int64
    face_atlas: np.ndarray  # (F,) int64: the atlas each triangle is painted in, -1 for a flat color
    face_color: np.ndarray  # (F, 3) float32: flat triangles' color (sRGB 0-1)
    atlases: list[np.ndarray] = field(default_factory=list)  # (S, S, 3) float32 sRGB 0-1
    extras: dict = field(default_factory=dict)  # the GLB scene's extras (the scan manifest)

    # A mesh is a value: edits make new ones (edit.apply), never change its arrays. So its triangles'
    # normals and areas are worked out once (code asks for them chart by chart, thousands of times),
    # and are read-only.
    @cached_property
    def face_normals(self) -> np.ndarray:
        a, b, c = (self.vertices[self.faces[:, k]].astype(np.float64) for k in range(3))
        n = np.cross(b - a, c - a)
        return read_only((n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)).astype(np.float32))

    @cached_property
    def face_areas(self) -> np.ndarray:
        return read_only(glb.triangle_area(self.vertices.astype(np.float64), self.faces))

    def texel_size(self) -> np.ndarray:
        """Each triangle's texel size in meters (inf for flat ones): how much of the surface one texel
        of its atlas covers."""
        out = np.full(len(self.faces), np.inf)
        for a, atlas in enumerate(self.atlases):
            sel = np.flatnonzero(self.face_atlas == a)
            if not len(sel):
                continue
            uv = self.uvs[self.faces[sel]].astype(np.float64) * np.array([atlas.shape[1], atlas.shape[0]])
            e1, e2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
            uv_area = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
            world = self.face_areas[sel]
            with np.errstate(divide="ignore", invalid="ignore"):
                out[sel] = np.where(uv_area > 1e-9, np.sqrt(world / uv_area), np.inf)
        return out

    def charts(self) -> np.ndarray:
        """(F,) chart index of every triangle: textured triangles joined by shared vertices, per atlas."""
        f = len(self.faces)
        rows = np.repeat(np.arange(f), 3)
        incidence = coo_matrix((np.ones(3 * f), (rows, self.faces.reshape(-1))), shape=(f, len(self.vertices))).tocsr()
        adjacency = incidence @ incidence.T
        _, labels = connected_components(adjacency, directed=False)
        # Triangles of different atlases never share vertices in the phone's GLB, but be safe.
        key = labels.astype(np.int64) * (len(self.atlases) + 2) + (self.face_atlas + 1)
        _, chart = np.unique(key, return_inverse=True)
        return chart


def read_only(a: np.ndarray) -> np.ndarray:
    a.setflags(write=False)
    return a


def decode(image: glb.Image) -> np.ndarray:
    with Image.open(io.BytesIO(image.data)) as im:
        return np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0


def encode(atlas: np.ndarray, mime: str = "image/jpeg", quality: int = 92) -> bytes:
    out = io.BytesIO()
    pixels = Image.fromarray((np.clip(atlas, 0, 1) * 255 + 0.5).astype(np.uint8))
    if mime == "image/png":
        pixels.save(out, "PNG", optimize=False)
    else:
        pixels.save(out, "JPEG", quality=quality, subsampling=0)
    return out.getvalue()


def srgb_of_linear(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def from_model(model: glb.Model) -> Mesh:
    """The textured triangles of a GLB (its materials' images become the atlases)."""
    atlas_of_image: dict[int, int] = {}
    atlases: list[np.ndarray] = []
    vertices, uvs, faces, face_atlas, face_color = [], [], [], [], []
    base = 0
    for p in model.primitives:
        material = model.materials[p.material] if p.material is not None and p.material < len(model.materials) else glb.Material("")
        if material.image is not None and p.uvs is not None:
            if material.image not in atlas_of_image:
                atlas_of_image[material.image] = len(atlases)
                atlases.append(decode(model.images[material.image]))
            atlas = atlas_of_image[material.image]
            uv = p.uvs
        else:
            atlas = -1
            uv = np.zeros((len(p.positions), 2), np.float32)
        vertices.append(p.positions)
        uvs.append(uv)
        faces.append(p.faces + base)
        face_atlas.append(np.full(len(p.faces), atlas, np.int64))
        face_color.append(np.tile(srgb_of_linear(np.asarray(material.color[:3], np.float32)), (len(p.faces), 1)))
        base += len(p.positions)
    if not faces:
        raise ValueError("the model has no triangles")
    return Mesh(
        vertices=np.concatenate(vertices).astype(np.float32),
        uvs=np.concatenate(uvs).astype(np.float32),
        faces=np.concatenate(faces).astype(np.int64),
        face_atlas=np.concatenate(face_atlas),
        face_color=np.concatenate(face_color).astype(np.float32),
        atlases=atlases,
        extras=dict(model.extras),
    )


def to_model(mesh: Mesh, quality: int = 92) -> glb.Model:
    """A GLB of the mesh: one unlit primitive per atlas (JPEG), as the phone writes its photo models,
    plus one per flat color."""
    model = glb.Model(extras=dict(mesh.extras))
    for a, atlas in enumerate(mesh.atlases):
        sel = np.flatnonzero(mesh.face_atlas == a)
        if not len(sel):
            continue
        model.images.append(glb.Image(encode(atlas, quality=quality), "image/jpeg", f"atlas{a}"))
        model.materials.append(glb.Material(f"Remastered_{a}", image=len(model.images) - 1))
        model.primitives.append(_primitive(mesh, sel, len(model.materials) - 1, f"Remastered_{a}", with_uvs=True))
    flat = np.flatnonzero(mesh.face_atlas < 0)
    if len(flat):
        colors, which = np.unique(np.round(mesh.face_color[flat] * 255).astype(np.int64), axis=0, return_inverse=True)
        for k, rgb in enumerate(colors):
            sel = flat[which.reshape(-1) == k]
            linear = np.power((rgb / 255.0 + 0.055) / 1.055, 2.4)
            model.materials.append(glb.Material(f"Flat_{k}", color=(*map(float, linear), 1.0)))
            model.primitives.append(_primitive(mesh, sel, len(model.materials) - 1, f"Flat_{k}", with_uvs=False))
    return model


def _primitive(mesh: Mesh, faces: np.ndarray, material: int, name: str, with_uvs: bool) -> glb.Primitive:
    used, local = np.unique(mesh.faces[faces].reshape(-1), return_inverse=True)
    return glb.Primitive(
        positions=mesh.vertices[used],
        faces=local.reshape(-1, 3).astype(np.int64),
        uvs=mesh.uvs[used] if with_uvs else None,
        material=material,
        name=name,
    )
