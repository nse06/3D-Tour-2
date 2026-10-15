"""Photo spots (spots.py): cubes of what the photos saw, from where they were taken."""

import math

import numpy as np

from atrium_photoreal.capture import load
from atrium_remaster import glb, scene, spots, views

from . import room


def test_cube_faces_round_trip_every_direction():
    n = 32
    faces = np.stack([spots.face_directions(f, n) for f in range(6)]).astype(np.float32)
    rng = np.random.default_rng(1)
    d = rng.normal(size=(5000, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    back = spots.cube_lookup(faces, d)
    assert np.degrees(np.arccos(np.clip((back * d).sum(1), -1, 1))).max() < 2 * 90 / n, "each direction finds its own pixel"
    # And the layout is OpenGL's: +x's top-left pixel looks up and toward +z.
    assert np.allclose(spots.face_directions(0, 2)[0, 0], np.array([1, 0.5, 0.5]) / math.sqrt(1.5))
    sheet = spots.faces_of(spots.grid_jpeg((faces * 127 + 128).astype(np.uint8), 95))
    assert np.abs(sheet.astype(int) - (faces * 127 + 128).astype(int)).mean() < 3


def test_spots_are_where_the_photos_were_taken(tmp_path):
    room.write(tmp_path)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    found = spots.choose(mesh, capture, spots.SpotConfig(spacing=0.6))
    assert 2 <= len(found) < len(capture.cameras) and sum(len(s.cameras) for s in found) == len(capture.cameras)
    for s in found:
        assert np.allclose(s.position, np.mean([c.camtoworld[:3, 3] for c in s.cameras], axis=0))
    assert len(spots.choose(mesh, capture, spots.SpotConfig(spacing=0.6, clearance=5.0))) == 0, "none clear of walls 5 m away"


def test_a_spot_shows_its_photo_in_the_skins_colors(tmp_path):
    """A spot where one photo was taken: its cube shows that photo where the photo looked (with the
    photo's exposure undone as training learned it), and the model elsewhere."""
    truth = room.write(tmp_path, smeared=(), noise=0.0)
    capture = load(tmp_path / "capture")
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    cam = capture.cameras[0]
    k = 0
    gain = 1 + 0.15 * math.sin(3 * k)  # room.write's exposure for photo k
    fixes = {cam.name: (np.eye(3, dtype=np.float32) * gain, np.zeros(3, np.float32), np.zeros(4, np.float32))}
    capture.cameras = [cam]
    cfg = spots.SpotConfig(face=64, long_side=160, clearance=0.1)
    (spot,) = spots.choose(mesh, capture, cfg)
    caster = views.Caster.of(mesh)
    photos = spots.Photos(mesh, caster, cfg, "cpu", None, None)
    forward = cam.camtoworld[:3, 2]
    face = int(np.argmax([spots.face_directions(f, 3)[1, 1] @ forward for f in range(6)]))
    painted = spots.paint_face(spot, face, mesh, caster, photos, [cam], fixes, cfg).astype(np.float32) / 255
    # The truth in the same directions.
    d = spots.face_directions(face, cfg.face).reshape(-1, 3)
    t, tri, bary = caster.rays(np.broadcast_to(spot.position, d.shape).astype(np.float32), d.astype(np.float32))
    hits = views.Hits(tri.reshape(64, 64), bary.reshape(64, 64, 2), t.reshape(64, 64))
    exact = room.truth_color(truth["charts"], truth["mesh"], hits)
    model = views.render(mesh, hits)
    # Where the photo looked (well inside its frame).
    local = d @ cam.camtoworld[:3, :3]
    u = cam.K[0, 0] * local[:, 0] / local[:, 2] + cam.K[0, 2]
    v = cam.K[1, 1] * local[:, 1] / local[:, 2] + cam.K[1, 2]
    centre = ((local[:, 2] > 0) & (u > 12) & (u < room.W - 12) & (v > 12) & (v < room.H - 12)).reshape(64, 64)
    assert centre.sum() > 1000
    photo_error = np.abs(painted[centre] - exact[centre]).mean()
    model_error = np.abs(model[centre] - exact[centre]).mean()
    assert photo_error < 0.6 * model_error and photo_error < 0.05, (photo_error, model_error)
    # Behind the camera, no photo: the model.
    back = spots.paint_face(spot, face ^ 1, mesh, caster, photos, [cam], fixes, cfg).astype(np.float32) / 255
    d = spots.face_directions(face ^ 1, cfg.face).reshape(-1, 3)
    t, tri, bary = caster.rays(np.broadcast_to(spot.position, d.shape).astype(np.float32), d.astype(np.float32))
    behind = views.render(mesh, views.Hits(tri.reshape(64, 64), bary.reshape(64, 64, 2), t.reshape(64, 64)))
    assert np.abs(back - behind).max() < 2 / 255


def test_what_a_photo_leaves_out_fades_in_around_it():
    """The phone's people mask is a coarse grid, and the depth model's disagreement is coarser than the
    photo: what they leave out is all out, and the photo fades back in around it instead of stepping
    from block to block (the steps showed as jagged outlines in the photo spots)."""
    grid = np.zeros((12, 16), bool)
    grid[4:9, 5:9] = True  # a person, in the phone's cells (10 px each at 160 × 120)
    w, h = 160, 120
    soft = spots.soft_quiet([grid, None], w, h)
    full = np.asarray(spots.Image.fromarray(soft).resize((w, h), spots.Image.BILINEAR), np.float32)
    person = np.asarray(spots.Image.fromarray(grid.astype(np.uint8) * 255).resize((w, h), spots.Image.NEAREST)) > 127
    assert full[person].min() > 0.9, "all of the person is left out"
    assert full[:, :20].max() < 0.01 and full[:, 120:].max() < 0.01, "far from it, nothing is"
    # Across its edge, a ramp several pixels wide rather than a step.
    row = full[60, 30:60]
    assert np.abs(np.diff(row)).max() < 0.3 and (row > 0.05).sum() - (row > 0.95).sum() >= 4, row.round(2)
    assert not spots.soft_quiet([None, np.zeros((30, 40), bool)], w, h).any(), "nothing left out"


def one_camera_spot(tmp_path, k: int, gain: float, **write):
    """The room with photo k alone, its color correction `gain` (as training learned it), and its spot."""
    truth = room.write(tmp_path, smeared=(), noise=0.0, **write)
    capture = load(tmp_path / "capture")
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    cam = capture.cameras[k]
    capture.cameras = [cam]
    fixes = {cam.name: (np.eye(3, dtype=np.float32) * gain, np.zeros(3, np.float32), np.zeros(4, np.float32))}
    cfg = spots.SpotConfig(face=64, long_side=160, clearance=0.1)
    (spot,) = spots.choose(mesh, capture, cfg)
    return truth, capture, mesh, cam, fixes, cfg, spot


def face_hits(caster, spot, face, n):
    d = spots.face_directions(face, n).reshape(-1, 3)
    t, tri, bary = caster.rays(np.broadcast_to(spot.position, d.shape).astype(np.float32), d.astype(np.float32))
    return d, views.Hits(tri.reshape(n, n), bary.reshape(n, n, 2), t.reshape(n, n))


def test_the_spots_get_the_lighting_once(tmp_path):
    """The model a spot is made from has its lighting already: where no photo saw, the cube shows it as
    it is, and the photos get the same lighting (a real home's spots showed their ceilings a quarter
    too bright and pink: lit twice)."""
    from atrium_remaster.light import Light

    k = 0
    truth, capture, mesh, cam, fixes, cfg, spot = one_camera_spot(tmp_path, k, 1 + 0.15 * math.sin(3 * k))
    lit = Light(gains=np.array([1.2, 1.05, 1.25], np.float32), lift=0.12, shoulder=0.8)
    (made,) = spots.run(mesh, capture, fixes, cfg, log=lambda _: None, light=lit)
    faces = spots.faces_of(made["jpeg"]).astype(np.float32) / 255
    caster = views.Caster.of(mesh)
    forward = cam.camtoworld[:3, 2]
    face = int(np.argmax([spots.face_directions(f, 3)[1, 1] @ forward for f in range(6)]))
    _, behind = face_hits(caster, spot, face ^ 1, cfg.face)
    model = views.render(mesh, behind)
    assert np.abs(faces[face ^ 1] - model).mean() < 4 / 255, "no photo behind it: the model, as it is"
    assert np.abs(faces[face ^ 1] - lit(model)).mean() > 0.04
    # Where the photo looked, the truth in the skins' colors, lit.
    d, ahead = face_hits(caster, spot, face, cfg.face)
    local = d @ cam.camtoworld[:3, :3]
    u = cam.K[0, 0] * local[:, 0] / local[:, 2] + cam.K[0, 2]
    v = cam.K[1, 1] * local[:, 1] / local[:, 2] + cam.K[1, 2]
    centre = ((local[:, 2] > 0) & (u > 12) & (u < room.W - 12) & (v > 12) & (v < room.H - 12)).reshape(cfg.face, cfg.face)
    exact = lit(room.truth_color(truth["charts"], truth["mesh"], ahead))
    assert np.abs(faces[face][centre] - exact[centre]).mean() < 0.05


def test_a_blown_out_photo_leaves_the_glass_to_the_model(tmp_path):
    """A window's glass is white in the photo however bright the glass really is, so a photo training
    found brighter than the skins would show it grey (white over its brightness): there the photo
    leaves it to the model, which knows it's white."""
    glow_center = np.array([1.5, 1.4, 3.0])  # room.GLOW's middle, on the z = 3 wall

    def off_centre(pose):  # pixels from the middle of the photo's frame
        local = (glow_center - pose[:3, 3]) @ pose[:3, :3]
        return float(np.hypot(*(room.F * local[:2] / local[2]))) if local[2] > 0 else np.inf

    off = [off_centre(pose) for pose in room.camera_poses(16)]
    k = int(np.argmin(off))
    assert off[k] < 30, "a photo has the glass in the middle of its frame"
    _, _, mesh, cam, fixes, cfg, spot = one_camera_spot(tmp_path, k, 1.3, glow=2.0)
    caster = views.Caster.of(mesh)
    face = int(np.argmax([spots.face_directions(f, 3)[1, 1] @ (glow_center - spot.position) for f in range(6)]))
    photos = spots.Photos(mesh, caster, cfg, "cpu", None, None)
    painted = spots.paint_face(spot, face, mesh, caster, photos, [cam], fixes, cfg).astype(np.float32) / 255
    d, hits = face_hits(caster, spot, face, cfg.face)
    points = views.surface_points(mesh, hits)
    a0, a1, b0, b1 = room.GLOW
    a, b = 3.0 - points[..., 0], room.SIZE[1] - points[..., 1]
    on_wall = hits.hit & (np.abs(points[..., 2] - 3.0) < 1e-3)
    glass = on_wall & (a > a0 + 0.15) & (a < a1 - 0.15) & (b > b0 + 0.15) & (b < b1 - 0.15)
    assert glass.sum() > 30
    assert painted[glass].min() > 0.95, painted[glass].min(axis=-1).min()
    # Beside it, in the photo's frame, the photo still shows (in the skins' colors: the wall darker
    # than the model, which has it as the photos showed it on average).
    local = d @ cam.camtoworld[:3, :3]
    u = (cam.K[0, 0] * local[:, 0] / local[:, 2] + cam.K[0, 2]).reshape(hits.shape)
    v = (cam.K[1, 1] * local[:, 1] / local[:, 2] + cam.K[1, 2]).reshape(hits.shape)
    framed = (local[:, 2] > 0).reshape(hits.shape) & (u > 10) & (u < room.W - 10) & (v > 10) & (v < room.H - 10)
    wall = on_wall & framed & ((a < a0 - 0.12) | (a > a1 + 0.12) | (b < b0 - 0.12) | (b > b1 + 0.12))
    assert wall.sum() > 30 and np.abs(painted[wall] - views.render(mesh, hits)[wall]).mean() > 0.03
