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
    names = sorted(a.name.split("-")[-1] for a in additions)
    assert names == ["back", "face", "sides"], "the cut wall, the window set back, its reveals"
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


def paint(atlas: np.ndarray, chart: room.Chart, a0: float, a1: float, b0: float, b1: float, color) -> None:
    """Paint the texels of a chart's rectangle [a0, a1] × [b0, b1] (meters along its u and v)."""
    x0, y0, _, _ = chart.rect
    cols = slice(x0 + room.PAD + int(round(a0 / room.TEXEL)), x0 + room.PAD + int(round(a1 / room.TEXEL)))
    rows = slice(y0 + room.PAD + int(round(b0 / room.TEXEL)), y0 + room.PAD + int(round(b1 / room.TEXEL)))
    atlas[rows, cols] = color


def painted_room(tmp_path, doc=None, paint_with=None):
    truth = room.write(tmp_path, layout=doc)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    atlas = mesh.atlases[0].copy()
    paint_with(atlas, truth["charts"])
    painted = scene.Mesh(mesh.vertices, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, [atlas], mesh.extras)
    lay = layout.load(tmp_path / "capture") if doc else layout.Layout()
    return truth, painted, lay


def baseboard(atlas, charts, wall=3):
    """A white 10 cm band along the bottom of a wall (v runs down the wall, from its top)."""
    w = charts[wall]
    paint(atlas, w, -0.04, w.width + 0.04, w.height - 0.10, w.height + 0.04, 0.95)


def test_a_baseboard_the_skins_show_becomes_a_shape(tmp_path):
    truth, painted, _ = painted_room(tmp_path, paint_with=baseboard)
    edited, stats = trim.run(painted, layout.Layout(), log=lambda _: None)
    assert stats["baseboards"] == 1 and stats["crowns"] == 0, "only the wall with a band (a checked wall has none)"
    new = np.arange(len(painted.faces), len(edited.faces))
    board = np.unique(edited.faces[new])
    assert abs(float(edited.vertices[board, 1].max()) - 0.10) < 0.015, "as tall as the band"
    assert abs(float(edited.vertices[board, 0].min()) - (3.0 - 0.012)) < 1e-4, "standing 12 mm out of the wall"
    caster = views.Caster.of(edited)
    pose = look(np.array([2.2, 0.4, 1.5]), -math.pi / 2, -0.4)
    hits = caster.view(truth["K"], pose, room.W, room.H)
    image = views.render(edited, hits)
    on_board = np.isin(hits.face, new) & (edited.face_atlas[np.maximum(hits.face, 0)] == 0)
    assert on_board.sum() > 50 and image[on_board].mean() > 0.85, "its face shows the white band"


def test_trim_around_a_door(tmp_path):
    """A door in the x = 3 wall, a white casing 8 cm wide around it, a baseboard: the door is set back,
    the baseboard stops at it, the casing stands out of the wall."""
    doc = room.layout_doc()
    doc["openings"] = [{"id": "D", "kind": "door", "wall": "W1", "center": [3.0, 1.0, 1.5], "along": [0, 0, 1], "normal": [-1, 0, 0], "width": 0.8, "height": 2.0}]

    def paint_with(atlas, charts):
        baseboard(atlas, charts)
        w = charts[3]  # u runs along z, v down from the top (y = 2.5)
        paint(atlas, w, 1.02, 1.10, 2.5 - 2.08, 2.5, 0.92)  # left of the door
        paint(atlas, w, 1.90, 1.98, 2.5 - 2.08, 2.5, 0.92)  # right
        paint(atlas, w, 1.02, 1.98, 2.5 - 2.08, 2.5 - 2.0, 0.92)  # over it

    truth, painted, lay = painted_room(tmp_path, doc, paint_with)
    edited, stats = trim.run(painted, lay, log=lambda _: None)
    assert stats["recessed"] == 1 and stats["casings"] == 1, stats
    assert stats["baseboards"] == 2, "one on each side of the door"
    caster = views.Caster.of(edited)
    old = views.Caster.of(painted)
    K = truth["K"]
    pose = look(np.array([1.5, 1.0, 1.5]), -math.pi / 2, 0.0)  # facing the door
    hits, before = caster.view(K, pose, room.W, room.H), old.view(K, pose, room.W, room.H)
    cy, cx = room.H // 2, room.W // 2
    assert abs(hits.depth[cy, cx] - (before.depth[cy, cx] + 0.1)) < 2e-3, "the door is set 10 cm back"
    # Just left of the door (z = 1.06 at the camera's height): the casing, 15 mm out of the wall.
    o, d = np.array([[1.5, 1.0, 1.06]]), np.array([[1.0, 0.0, 0.0]])
    t, _, _ = caster.rays(o, d)
    assert abs(float(t[0]) - (1.5 - 0.015)) < 2e-3
    # At the floor under the door: no baseboard across it.
    t, _, _ = caster.rays(np.array([[1.5, 0.05, 1.5]]), d)
    assert float(t[0]) > 1.55
    # The baseboard beside it.
    t, _, _ = caster.rays(np.array([[1.5, 0.05, 2.5]]), d)
    assert abs(float(t[0]) - (1.5 - 0.012)) < 2e-3


def test_cabinet_doors_drawers_and_toe_kick(tmp_path):
    """The cabinet against the z = 0 wall, painted as two doors under a drawer on the left, over a
    dark toe kick: a groove between the doors, one under the drawer, the kick set back."""

    def paint_with(atlas, charts):
        front = charts[6]  # cab_front: u along x from x = 1.0, v down from y = 0.9
        paint(atlas, front, -0.04, 0.84, -0.04, 0.94, (0.62, 0.52, 0.40))
        paint(atlas, front, 0.40, 0.42, 0.0, 0.78, 0.08)  # between the doors, down to the kick
        paint(atlas, front, 0.0, 0.40, 0.20, 0.22, 0.08)  # under the drawer on the left
        paint(atlas, front, -0.04, 0.84, 0.78, 0.94, 0.12)  # the toe kick, 12 cm

    truth, painted, lay = painted_room(tmp_path, room.layout_doc(), paint_with)
    edited, stats = trim.run(painted, lay, trim.TrimConfig(recess=False, casings=False), log=lambda _: None)
    assert stats["cabinetGaps"] == 2 and stats["toeKicks"] == 1, stats
    caster = views.Caster.of(edited)
    d = np.array([[0.0, 0.0, -1.0]])
    depth = lambda x, y: float(caster.rays(np.array([[x, y, 1.5]]), d)[0][0])  # noqa: E731
    assert abs(depth(1.6, 0.5) - 1.0) < 1e-3, "a door's face stays where it was"
    assert abs(depth(1.41, 0.5) - 1.015) < 2e-3, "the gap between the doors is a groove"
    assert abs(depth(1.2, 0.69) - 1.015) < 2e-3, "so is the one under the drawer"
    assert abs(depth(1.6, 0.69) - 1.0) < 1e-3, "which stops at the doors' gap"
    assert abs(depth(1.6, 0.05) - 1.06) < 2e-3, "the toe kick is set 6 cm back"


def test_a_window_casing_with_an_apron(tmp_path):
    """The window in the x = 3 wall (z 1-2 m, y 0.9-1.9 m) with an 8 cm casing all around it."""

    def paint_with(atlas, charts):
        w = charts[3]
        paint(atlas, w, 0.92, 2.08, 2.5 - 1.98, 2.5 - 0.82, 0.92)
        paint(atlas, w, 1.0, 2.0, 2.5 - 1.9, 2.5 - 0.9, (0.3, 0.45, 0.6))  # the glass

    truth, painted, lay = painted_room(tmp_path, room.layout_doc(), paint_with)
    edited, stats = trim.run(painted, lay, trim.TrimConfig(baseboards=False, crowns=False, cabinets=False), log=lambda _: None)
    assert stats["recessed"] == 1 and stats["casings"] == 1, stats
    caster = views.Caster.of(edited)
    d = np.array([[1.0, 0.0, 0.0]])
    out = lambda z, y: 3.0 - (1.5 + float(caster.rays(np.array([[1.5, y, z]]), d)[0][0]))  # noqa: E731
    assert abs(out(0.96, 1.4) - 0.015) < 2e-3, "left of it"
    assert abs(out(2.04, 1.4) - 0.015) < 2e-3, "right of it"
    assert abs(out(1.5, 1.94) - 0.015) < 2e-3, "over it"
    assert abs(out(1.5, 0.86) - 0.015) < 2e-3, "under it, the apron"
    assert abs(out(1.5, 1.4) + 0.1) < 2e-3, "the window itself, set back"
    assert abs(out(0.5, 1.4)) < 1e-3, "the wall"
