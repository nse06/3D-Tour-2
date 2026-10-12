"""Finer shapes for what the LiDAR scanned (fuse.py): the depth at many photos fused into one surface
in place of the scanned piece, where it explains the photos better."""

import math

import numpy as np

from atrium_photoreal.capture import Camera, load
from atrium_remaster import edit, fuse, glb, layout, scene, views

from . import room
from .test_furniture import aim


def table() -> tuple[np.ndarray, np.ndarray]:
    """What the scan took for a cabinet (x 1.0-1.8, y 0-0.9, z 0-0.5): a table, its top and four legs."""
    parts = [((1.4, 0.875, 0.25), (0.8, 0.05, 0.5))] + [((x, 0.425, z), (0.06, 0.85, 0.06)) for x in (1.03, 1.77) for z in (0.03, 0.47)]
    vs, fs = [], []
    for center, size in parts:
        v, f = edit.box(np.array(center), np.eye(3), np.array(size))
        fs.append(f + sum(len(x) for x in vs))
        vs.append(v)
    return np.concatenate(vs).astype(np.float64), np.concatenate(fs)


def test_a_lidar_piece_is_fused_anew_from_the_depth(tmp_path):
    doc = room.layout_doc()
    doc["objects"][0]["lidar"] = True
    truth = room.write(tmp_path, layout=doc)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    # The room as it is: a table where the scan has a box.
    cabinet = np.repeat(np.arange(len(truth["charts"])), 2) >= 6
    tv, tf = table()
    real = views.Caster(np.concatenate([truth["mesh"].vertices, tv]), np.concatenate([truth["mesh"].faces[~cabinet], tf + len(truth["mesh"].vertices)]))
    K = truth["K"]
    # A few more photos looking at it (the test room's photos mostly look past it).
    for k in range(6):
        a = -0.9 + 0.36 * k
        pose = aim(np.array([1.4 + 1.3 * math.sin(a), 1.2 + 0.1 * k, 0.25 + 1.3 * math.cos(a)]), np.array([1.4, 0.45, 0.25]))
        capture.cameras.append(Camera(f"extra{k}", capture.cameras[0].image_path, None, room.W, room.H, K.copy(), pose))
    depths = {c.name: (real.view(K, c.camtoworld, room.W, room.H).depth, K) for c in capture.cameras}
    out, stats = fuse.run(mesh, capture, layout.load(tmp_path / "capture"), depths, log=lambda _: None)
    assert stats["fused"] == 1, stats
    # Seen from the front, between the legs and under the top: the wall behind now, as in the photos.
    pose = aim(np.array([1.4, 0.9, 1.6]), np.array([1.4, 0.45, 0.25]))
    seen, scanned, actual = (views.Caster.of(m).view(K, pose, room.W, room.H) if m is not None else real.view(K, pose, room.W, room.H) for m in (out, mesh, None))
    region = np.isin(scanned.face, np.flatnonzero(cabinet))
    right = lambda h: (np.abs(h.depth - actual.depth) < 0.03)[region].mean()  # noqa: E731
    assert right(scanned) < 0.6 and right(seen) > 0.85, (right(scanned), right(seen))
    # The fused surface faces the photos.
    new = seen.face >= len(mesh.faces) - int(cabinet.sum())
    normals = out.face_normals[seen.face[new]]
    rays = (views.surface_points(out, seen)[new] - pose[:3, 3]).astype(np.float64)
    assert (np.einsum("ij,ij->i", normals, rays) < 0).mean() > 0.9


def test_a_fusion_that_explains_nothing_new_is_left_out(tmp_path):
    doc = room.layout_doc()
    doc["objects"][0]["lidar"] = True
    truth = room.write(tmp_path, layout=doc)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    K = truth["K"]
    for k in range(6):
        a = -0.9 + 0.36 * k
        pose = aim(np.array([1.4 + 1.3 * math.sin(a), 1.2 + 0.1 * k, 0.25 + 1.3 * math.cos(a)]), np.array([1.4, 0.45, 0.25]))
        capture.cameras.append(Camera(f"extra{k}", capture.cameras[0].image_path, None, room.W, room.H, K.copy(), pose))
    model = views.Caster.of(mesh)  # the depth agrees with the scan: nothing to gain
    depths = {c.name: (model.view(K, c.camtoworld, room.W, room.H).depth, K) for c in capture.cameras}
    out, stats = fuse.run(mesh, capture, layout.load(tmp_path / "capture"), depths, log=lambda _: None)
    assert out is mesh and stats["fused"] == 0 and stats["fusedKept"] == 1


def test_the_job_reshapes_lidar_pieces_with_the_depth_model(tmp_path):
    """With the stand-in depth model (it returns its prompt: the scan's own depth), nothing is gained,
    so the scanned shape stays; the stage runs, and the photos' depth is still compared."""
    from atrium_remaster.depth import PromptAsDepth
    from atrium_remaster.job import Services, remaster

    doc = room.layout_doc()
    doc["objects"][0]["lidar"] = True
    room.write(tmp_path, layout=doc)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    options = {"steps": 10, "batch": 2, "tile": 128, "longSide": 160, "fill": False, "trim": False, "fixerViews": False}
    out, stats = remaster(mesh, capture, options, Services(depth=PromptAsDepth()), "cpu", lambda *a: None, log=lambda _: None, layout=layout.load(tmp_path / "capture"))
    assert stats["fused"] == 0 and "depthDisagreeShare" in stats and "fuseError" not in stats, stats
