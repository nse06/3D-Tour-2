"""Photos smeared by the phone turning count less where sharper photos saw the same surfaces
(sharpness.py).  Run: cd worker/photoreal && python -m pytest tests -q"""

import json
from pathlib import Path

import numpy as np

from atrium_photoreal.capture import Camera, load
from atrium_photoreal.sharpness import photo_weights, smear_px, visible_seeds
from atrium_photoreal.train import TrainConfig, train

from . import scene

W, H, F = 640, 480, 500.0


def camera(x=0.0, z=0.0, facing=1.0, turn=None, exposure=1 / 30, speed=None):
    """An OpenCV camera at (x, 0, z) looking along +z (facing 1) or -z (facing -1)."""
    c2w = np.diag([facing, 1.0, facing, 1.0])
    c2w[:3, 3] = [x, 0.0, z]
    K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])
    return Camera("c", Path("c.jpg"), None, W, H, K, c2w, turn, exposure, speed)


def wall(z, half=2.0, step=0.05):
    """Points on the plane z = const, 2·half meters across."""
    g = np.arange(-half, half + 1e-9, step)
    x, y = np.meshgrid(g, g * 0.75)
    return np.c_[x.ravel(), y.ravel(), np.full(x.size, z)]


def test_smear_is_turn_rate_times_exposure_times_focal_length():
    assert abs(smear_px(camera(turn=0.2)) - 0.2 / 30 * F) < 1e-9
    assert abs(smear_px(camera(turn=0.2), scale=0.5) - 0.1 / 30 * F) < 1e-9
    # No exposure time recorded: ScanCore's 1/50 s.
    assert abs(smear_px(camera(turn=0.2, exposure=None)) - 0.2 * 0.02 * F) < 1e-9
    assert smear_px(camera(turn=None)) is None
    # Walking at 0.3 m/s past things 1.5 m away smears like turning at 0.2 rad/s; both add up like a
    # vector's sides (build 11 records the speed).
    assert abs(smear_px(camera(turn=0.0, speed=0.3)) - 0.2 / 30 * F) < 1e-9
    assert abs(smear_px(camera(turn=0.2, speed=0.3)) - 0.2 / 30 * F * np.sqrt(2)) < 1e-9


def test_a_smeared_photo_defers_to_sharper_photos_of_the_same_wall():
    points = np.r_[wall(3.0), wall(-3.0)]
    cams = [
        camera(-0.2, turn=0.01),
        camera(-0.1, turn=0.01),
        camera(0.1, turn=0.5),
        camera(0.2, turn=0.5),
        # The only photo of the wall behind: smeared, but nothing saw it better.
        camera(0.0, facing=-1.0, turn=0.5),
    ]
    weights, smear = photo_weights(cams, [1.0] * len(cams), points)
    assert np.allclose(smear, [0.01 / 30 * F] * 2 + [0.5 / 30 * F] * 3)
    assert weights[0] > 0.95 and weights[1] > 0.95
    expected = (smear[0] + 1) / (smear[2] + 1)
    assert abs(weights[2] - expected) < 0.05 and abs(weights[3] - expected) < 0.05, weights
    assert weights[4] > 0.95


def test_surfaces_behind_a_wall_dont_count():
    near, far = wall(2.0, half=4.0), wall(4.0)
    blurry_in_front = camera(0.0, z=0.0, turn=0.5)
    sharp_behind_the_wall = camera(0.0, z=3.0, turn=0.01)
    seen = visible_seeds([blurry_in_front], np.r_[near, far])
    # The near wall fills the frame (about a tenth of it is in view); the far one is hidden.
    assert seen[0, : len(near)].sum() > 2000 and not seen[0, len(near) :].any()
    # The blurry photo is still the best view of the near wall: it keeps its say.
    weights, _ = photo_weights([blurry_in_front, sharp_behind_the_wall], [1.0, 1.0], np.r_[near, far])
    assert weights[0] > 0.95 and weights[1] > 0.95


def test_without_turn_rates_every_photo_counts():
    cams = [camera(-0.1), camera(0.1)]
    weights, smear = photo_weights(cams, [1.0, 1.0], wall(3.0))
    assert np.isnan(smear).all() and np.allclose(weights, 1.0)


def test_training_reports_the_smear(tmp_path):
    folder = scene.write(tmp_path / "capture")
    doc = json.loads((folder / "cameras.json").read_text())
    for k, frame in enumerate(doc["frames"]):
        frame["turnRate"], frame["exposure"] = (0.02 if k % 2 else 3.0), 1 / 30
    (folder / "cameras.json").write_text(json.dumps(doc))
    capture = load(folder)
    assert capture.cameras[0].turn_rate == 3.0 and abs(capture.cameras[0].exposure - 1 / 30) < 1e-12
    result = train(capture, TrainConfig(steps=20, long_side=32, sh_degree=0, progress_every=10), device="cpu", log=lambda _: None)
    smear = result.stats["smearPx"]
    assert smear["max"] > smear["median"] > 0 and result.stats["blurWeighting"] is True
    # Every other photo is smeared 2.8 px (at 32 px across) and its neighbors saw the same floor sharp.
    assert result.stats["photosLeftToSharper"] == 6
