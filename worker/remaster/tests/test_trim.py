"""Doors and windows set into their walls (trim.py)."""

import math

import numpy as np

from atrium_photoreal.enhance import look
from atrium_remaster import edit, glb, layout, scene, trim, views

from . import room


def test_a_window_is_set_into_its_wall_and_keeps_its_texels(tmp_path):
    truth = room.write(tmp_path, layout=room.layout_doc())
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    lay = layout.load(tmp_path / "capture")
    remove, additions, stats = trim.recess(mesh, lay, log=lambda _: None)
    assert stats["recessed"] == 1 and stats["recessSkipped"] == 0
    chart = np.repeat(np.arange(len(truth["charts"])), 2)
    assert set(chart[remove]) == {3}, "only the x = 3 wall is cut"
    names = sorted(a.name.split("-")[0] for a in additions)
    assert names == ["reveal"] * 4 + ["wall", "window"]
    edited, edit_stats = edit.apply(mesh, remove, additions)
    # Looking at the window square on: the wall around it where it was, the window 10 cm further back,
    # and both showing what was painted there.
    caster = views.Caster.of(edited)
    K = truth["K"]
    pose = look(np.array([1.5, 1.4, 1.5]), -math.pi / 2, 0.0)  # at the room's middle, looking along +x
    hits = caster.view(K, pose, room.W, room.H)
    old = views.Caster.of(mesh).view(K, pose, room.W, room.H)
    cy, cx = room.H // 2, room.W // 2
    assert abs(hits.depth[cy, cx] - (old.depth[cy, cx] + 0.1)) < 1e-3, "the window sits 10 cm back"
    corner = (5, 5)
    assert abs(hits.depth[corner] - old.depth[corner]) < 1e-3, "the wall around it hasn't moved"
    before, after = views.render(mesh, old), views.render(edited, hits)
    assert np.abs(after[cy - 5 : cy + 5, cx - 5 : cx + 5] - before[cy - 5 : cy + 5, cx - 5 : cx + 5]).mean() < 0.03
    assert np.abs(after[:10, :10] - before[:10, :10]).mean() < 0.01
    # From the side, a reveal shows: the cut wall's edge is no longer flush.
    side = look(np.array([2.2, 1.4, 0.6]), -math.pi / 2 - 0.9, 0.0)
    h2 = caster.view(K, side, room.W, room.H)
    reveal = np.isin(h2.face, np.flatnonzero(edited.face_atlas == len(mesh.atlases)))
    assert reveal.sum() > 20 and edit_stats["newAtlas"] >= 16


def test_open_doors_and_walls_without_their_opening_are_left_alone(tmp_path):
    doc = room.layout_doc()
    doc["openings"] = [
        {"id": "D", "kind": "door", "open": True, "center": [1.5, 1.0, 3.0], "along": [1, 0, 0], "normal": [0, 0, 1], "width": 0.8, "height": 2.0},
        {"id": "X", "kind": "window", "center": [9.0, 1.4, 1.5], "along": [0, 0, 1], "normal": [-1, 0, 0], "width": 1.0, "height": 1.0},
    ]
    room.write(tmp_path, layout=doc)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    remove, additions, stats = trim.recess(mesh, layout.load(tmp_path / "capture"), log=lambda _: None)
    assert not remove.any() and not additions and stats["recessed"] == 0 and stats["recessSkipped"] == 1
