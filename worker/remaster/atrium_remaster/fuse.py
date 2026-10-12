"""Finer shapes for what the LiDAR scanned (docs/remaster.md §4.3).

Where the phone kept the LiDAR's mesh in place of RoomPlan's box (shelves, a kitchen island, a toilet,
a sofa the furniture stage left alone), the shape is ARKit's coarse mesh, smoothed: legs melt into
blobs, edges round off. The depth model's sharp depth at every photo that sees such a piece (depth.py,
prompted with the model's own depth) is fused into one surface (Open3D's TSDF, 1 cm voxels), within
the piece's box; what duplicates the rest of the model (the floor under it, the wall behind it) is
dropped. The fused shape replaces the scanned one only where it explains the photos' depth better
than the scanned shape did; the skins then learn its colors.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .edit import Addition, apply
from .furniture import FurnitureConfig, hull_mask, main_parts, piece_faces, sights, simplify, spread_out
from .layout import Layout
from .scene import Mesh
from .views import Caster, sample


@dataclass
class FuseConfig:
    voxel: float = 0.01
    trunc: float = 0.04
    max_resolution: int = 320  # voxels across (bigger pieces get bigger voxels)
    margin: float = 0.05  # LiDAR shapes stick out of their box a little
    views: int = 24  # photos fused per piece
    min_views: int = 2
    min_size: float = 0.06  # a photo shows the piece's box at least this big (of the photo's long side)
    off_rest: float = 0.015  # fused surface this close to the rest of the model is the rest (floor, wall)
    agree_abs: float = 0.03  # a pixel's depth explained: within this plus agree_rel of the distance
    agree_rel: float = 0.02
    better: float = 0.05  # the fused shape must explain this much more of the piece's pixels
    max_faces: int = 40000


def back_project(depth: np.ndarray, K: np.ndarray, camtoworld: np.ndarray) -> np.ndarray:
    """(H, W, 3) world points of a depth map (OpenCV camera, pixel centers at half pixels)."""
    h, w = depth.shape
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    local = np.stack([(u - K[0, 2]) / K[0, 0] * depth, (v - K[1, 2]) / K[1, 1] * depth, depth], -1)
    return local @ camtoworld[:3, :3].T + camtoworld[:3, 3]


def tsdf(views: list, depths: dict, box, cfg: FuseConfig) -> tuple[np.ndarray, np.ndarray] | None:
    """The surface the views' depth shows within the box (and its margin)."""
    import open3d as o3d

    # A cube around the box (Open3D's scalable volume comes out empty in its CPU build).
    corners = box.corners()
    lo = corners.min(0) - cfg.margin - 2 * cfg.trunc
    length = float((corners.max(0) + cfg.margin + 2 * cfg.trunc - lo).max())
    resolution = min(cfg.max_resolution, int(np.ceil(length / cfg.voxel)))
    volume = o3d.pipelines.integration.UniformTSDFVolume(
        length=length, resolution=resolution, sdf_trunc=max(cfg.trunc, 3 * length / resolution), color_type=o3d.pipelines.integration.TSDFVolumeColorType.NoColor, origin=lo
    )
    used = 0
    for s in views:
        depth, K = depths[s.camera.name]
        h, w = depth.shape
        points = back_project(depth, K, s.camera.camtoworld)
        keep = np.isfinite(depth) & (depth > 0.1) & box.contains(points.reshape(-1, 3), cfg.margin).reshape(h, w)
        if keep.sum() < 50:
            continue
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.zeros((h, w, 3), np.uint8)),
            o3d.geometry.Image(np.where(keep, depth, 0).astype(np.float32)),
            depth_scale=1.0,
            depth_trunc=20.0,
            convert_rgb_to_intensity=False,
        )
        # Open3D's pixel centers are at whole pixels: half a pixel off ours.
        intrinsic = o3d.camera.PinholeCameraIntrinsic(w, h, K[0, 0], K[1, 1], K[0, 2] - 0.5, K[1, 2] - 0.5)
        volume.integrate(rgbd, intrinsic, np.linalg.inv(s.camera.camtoworld))
        used += 1
    if used < cfg.min_views:
        return None
    m = volume.extract_triangle_mesh()
    if len(m.triangles) == 0:
        return None
    return np.asarray(m.vertices), np.asarray(m.triangles, np.int64)


def explained(caster: Caster, views: list, depths: dict, hulls: list[np.ndarray], cfg: FuseConfig) -> float:
    """The share of the piece's pixels (inside its box's outline in each view) whose depth the model
    explains."""
    good = total = 0
    for s, hull in zip(views, hulls):
        depth, K = depths[s.camera.name]
        h, w = depth.shape
        modeled = caster.view(K, s.camera.camtoworld, w, h).depth
        with np.errstate(invalid="ignore"):
            ok = np.abs(modeled - depth) <= cfg.agree_abs + cfg.agree_rel * depth
        good += int((ok & hull).sum())
        total += int(hull.sum())
    return good / total if total else 0.0


def piece_color(mesh: Mesh, faces: np.ndarray) -> tuple[float, float, float]:
    """The median of what's painted on a piece (sRGB)."""
    colors = []
    for a, atlas in enumerate(mesh.atlases):
        sel = faces[mesh.face_atlas[faces] == a]
        if len(sel):
            colors.append(sample(atlas, mesh.uvs[mesh.faces[sel]].mean(1)))
    flat = faces[mesh.face_atlas[faces] < 0]
    if len(flat):
        colors.append(mesh.face_color[flat])
    return tuple(float(c) for c in np.median(np.concatenate(colors), 0)) if colors else (0.6, 0.6, 0.6)


def run(mesh: Mesh, capture, layout: Layout, depths: dict, cfg: FuseConfig = FuseConfig(), skip=(), log=print) -> tuple[Mesh, dict]:
    """The mesh with its LiDAR pieces (but those in `skip`) fused anew from the depth, where that
    explains the photos better."""
    import open3d as o3d

    from .fill import flat_charts

    targets = [b for b in layout.objects if b.lidar and b.id not in set(skip)]
    stats: dict = {"fused": 0, "fusedKept": 0}
    if not targets or not depths:
        return mesh, stats
    chart = mesh.charts()
    flat = set(flat_charts(mesh, chart, 10.0))
    caster = Caster.of(mesh)
    cameras = [c for c in capture.cameras if c.name in depths]
    long_side = max(max(d.shape) for d, _ in depths.values())
    look = FurnitureConfig(long_side=long_side, min_size=cfg.min_size, in_frame=0.5)
    remove = np.zeros(len(mesh.faces), bool)
    additions: list[Addition] = []
    for b in targets:
        piece = piece_faces(mesh, b, chart, flat, cfg.margin)
        views = spread_out(sights(caster, piece, b, cameras, look), cfg.views, 10.0) if piece.any() else []
        shape = tsdf(views, depths, b, cfg) if len(views) >= cfg.min_views else None
        if shape is None:
            stats["fusedKept"] += 1
            continue
        v, f = shape
        rest_v, rest_f = mesh.vertices, mesh.faces[~piece & ~remove]
        rest = o3d.t.geometry.RaycastingScene()
        rest.add_triangles(o3d.core.Tensor(np.ascontiguousarray(rest_v, np.float32)), o3d.core.Tensor(np.ascontiguousarray(rest_f, np.uint32)))
        off = rest.compute_distance(o3d.core.Tensor(v[f].mean(1).astype(np.float32))).numpy() > cfg.off_rest
        f = f[off & b.contains(v[f].mean(1), cfg.margin)]
        if len(f) < 8:
            stats["fusedKept"] += 1
            continue
        v, f = simplify(*main_parts(v, f), cfg.max_faces)
        hulls = [hull_mask(s.hull, s.width, s.height, 0.0) for s in views]
        before = explained(caster, views, depths, hulls, cfg)
        after = explained(Caster(np.concatenate([rest_v, v]), np.concatenate([rest_f, f + len(rest_v)])), views, depths, hulls, cfg)
        if after < before + cfg.better:
            log(f"fuse: {b.category} {b.id}: explains {after:.0%} of its depth, the scanned shape {before:.0%}; kept")
            stats["fusedKept"] += 1
            continue
        log(f"fuse: {b.category} {b.id}: {len(f)} triangles from {len(views)} photos, explains {after:.0%} of its depth (was {before:.0%})")
        additions.append(Addition(v.astype(np.float32), f, color=piece_color(mesh, np.flatnonzero(piece)), name=f"fused-{b.id}"))
        remove |= piece
    if not additions:
        return mesh, stats
    out, edit_stats = apply(mesh, remove, additions)
    stats["fused"] = len(additions)
    stats["fusedTriangles"] = int(sum(len(a.faces) for a in additions))
    return out, stats
