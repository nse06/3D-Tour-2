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
