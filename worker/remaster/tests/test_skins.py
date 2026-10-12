"""Skins trained on every photo (skins.py): sharper and evener than the phone's painting."""

import math

import numpy as np

from atrium_photoreal.capture import load
from atrium_photoreal.enhance import look
from atrium_remaster import glb, scene, skins, views

from . import room

FAST = dict(steps=150, batch=4, tile=256, lr=0.03, progress_every=0, levels=3, max_mip=3)


def held_out_error(truth, mesh, count=5):
    caster = views.Caster.of(mesh)
    errors = []
    for k in range(count):
        pose = look(np.array([1.2 + 0.1 * k, 1.45, 1.4 + 0.2 * math.sin(k)]), 0.9 * k + 0.3, -0.2)
        hits = caster.view(truth["K"], pose, room.W, room.H)
        exact = room.truth_color(truth["charts"], truth["mesh"], hits)
        errors.append(np.abs(views.render(mesh, hits) - exact).mean())
    return float(np.mean(errors))


def test_trained_skins_beat_the_painting_where_buyers_walk(tmp_path):
    truth = room.write(tmp_path)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    cfg = skins.SkinConfig(**FAST)
    views_ = skins.prepare_photos(mesh, capture, cfg, log=lambda _: None)
    result = skins.train(mesh, views_, cfg, log=lambda _: None)
    assert result.mesh.atlases[0].shape == (1024, 1024, 3), "twice as many texels across"
    painted, trained = held_out_error(truth, mesh), held_out_error(truth, result.mesh)
    assert trained < 0.7 * painted, (painted, trained)
    # A patch the painting left flat gets its detail back from the photos.
    rows, cols = truth["flat_patch"]
    up = slice(2 * rows.start + 4, 2 * rows.stop - 4), slice(2 * cols.start + 4, 2 * cols.stop - 4)
    truth_up = np.repeat(np.repeat(truth["truth"], 2, 0), 2, 1)
    assert np.abs(result.mesh.atlases[0][up] - truth_up[up]).mean() < 0.5 * np.abs(np.repeat(np.repeat(mesh.atlases[0], 2, 0), 2, 1)[up] - truth_up[up]).mean()
    # The floor under the cabinet: no photo sees it, and the coverage says so. It keeps the phone's
    # colors but for the broad correction the floor around it got (its brightness), so it comes out no
    # further from the truth than it was.
    seen = result.seen[0]
    fx0, fy0, _, _ = truth["charts"][0].rect
    under = slice(2 * (fy0 + room.PAD) + 4, 2 * (fy0 + room.PAD + 25) - 4), slice(2 * (fx0 + room.PAD + 50) + 4, 2 * (fx0 + room.PAD + 90) - 4)
    assert (seen[under] == 0).all()
    painted_up = np.repeat(np.repeat(mesh.atlases[0], 2, 0), 2, 1)
    assert np.abs(result.mesh.atlases[0][under] - truth_up[under]).mean() <= np.abs(painted_up[under] - truth_up[under]).mean() + 0.01
    assert 0.1 < (seen > 0).mean() < 0.9
    assert result.stats["skinViews"] == len(capture.cameras)


def test_edges_and_grazing_views_say_nothing(tmp_path):
    truth = room.write(tmp_path)
    capture = load(tmp_path / "capture")
    mesh = truth["mesh"]
    caster = views.Caster.of(mesh)
    cam = capture.cameras[0]
    hits = caster.view(cam.K, cam.camtoworld, cam.width, cam.height)
    edge = skins.edges(hits, mesh, mesh.face_normals, 0)
    # Every pixel next to another surface at an angle (room corners, the cabinet's outline) is an edge.
    face = hits.face
    chart = np.repeat(np.arange(len(truth["charts"])), 2)[face]
    border = (chart != np.roll(chart, -1, 1))[:, :-1]
    assert edge[:, :-1][border].all()
    assert 0 < edge.mean() < 0.3


def test_the_trained_size_respects_the_texel_budget():
    mesh = scene.Mesh(
        np.zeros((3, 3), np.float32), np.zeros((3, 2), np.float32), np.array([[0, 1, 2]]), np.array([0]), np.zeros((1, 3), np.float32), [np.zeros((2048, 2048, 3), np.float32)] * 4
    )
    assert skins.trained_size(mesh, skins.SkinConfig(scale=2.0, max_texels=10**9)) == [4096] * 4
    sizes = skins.trained_size(mesh, skins.SkinConfig(scale=2.0, max_texels=40_000_000))
    assert all(s % 16 == 0 for s in sizes) and 4 * sizes[0] ** 2 <= 40_000_000 * 1.01 and sizes[0] > 2048


def test_cleaned_views_where_buyers_walk_feed_the_skins(tmp_path):
    from atrium_photoreal.enhance import SmoothingFixer

    from atrium_remaster import fixviews

    truth = room.write(tmp_path)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    cfg = skins.SkinConfig(**FAST)
    views_ = skins.prepare_photos(mesh, capture, cfg, log=lambda _: None)
    seen = []

    class Counting(SmoothingFixer):
        def __call__(self, images):
            seen.append([im.shape for im in images])
            return super().__call__(images)

    fix_cfg = fixviews.FixerViewsConfig(rounds=2, views=6, width=96, height=54)
    extra = fixviews.fixer_views(mesh, capture, cfg, fix_cfg, Counting(), log=lambda _: None)
    result = skins.train(mesh, views_, cfg, log=lambda _: None, extra=extra)
    assert len(seen) == 2 and all(shape == (54, 96, 3) for round_ in seen for shape in round_), "two rounds of the views, at the fixer's size"
    assert result.stats["extraRounds"] == 2 and 0 < result.stats["extraViews"] <= 6
    assert result.stats["skinViews"] == len(capture.cameras), "the photos alone count as seen"
    assert held_out_error(truth, result.mesh) < 0.8 * held_out_error(truth, mesh)
