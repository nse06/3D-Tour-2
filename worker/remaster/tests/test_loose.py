"""Loose pieces (loose.py): what the scanner kept that isn't there goes, what's there stays."""

import numpy as np

from atrium_photoreal.capture import load
from atrium_remaster import edit, glb, layout, loose, scene, views

from . import room


def with_boxes(mesh: scene.Mesh, *boxes) -> scene.Mesh:
    """The mesh and flat-colored boxes, (center, size) each, as loose pieces of the scan."""
    vertices, uvs, faces, atlas, color = [mesh.vertices], [mesh.uvs], [mesh.faces], [mesh.face_atlas], [mesh.face_color]
    n = len(mesh.vertices)
    for center, size in boxes:
        v, f = edit.box(np.asarray(center, np.float64), np.eye(3), np.asarray(size, np.float64))
        vertices.append(v)
        uvs.append(np.zeros((len(v), 2), np.float32))
        faces.append(f + n)
        atlas.append(np.full(len(f), -1, np.int64))
        color.append(np.full((len(f), 3), 0.3, np.float32))
        n += len(v)
    return scene.Mesh(np.concatenate(vertices), np.concatenate(uvs), np.concatenate(faces), np.concatenate(atlas), np.concatenate(color), mesh.atlases, mesh.extras)


def boxes_left(mesh: scene.Mesh, centers) -> list[bool]:
    """For each center, whether a piece of the mesh is still there."""
    found = loose.measure(mesh, loose.LooseConfig())
    middles = found.middle
    return [bool((np.linalg.norm(middles - np.asarray(c), axis=1) < 0.02).any()) for c in centers]


def test_pieces_that_touch_nothing_and_low_clutter_go(tmp_path):
    room.write(tmp_path, layout=room.layout_doc())
    capture = load(tmp_path / "capture")
    plan = layout.load(tmp_path / "capture")
    base = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    floating = (2.2, 1.1, 1.6)  # a piece of a leg, mid-air
    shoe = (1.6, 0.07, 2.2)  # the top of a shoe over the floor
    patch = (0.5, 0.005, 1.5)  # a flat patch of floor: floor
    on_wall = (0.06, 1.4, 1.0)  # a picture's frame on the x = 0 wall
    in_box = (1.4, 1.0, 0.25)  # over the cabinet RoomPlan measured
    lamp = (2.2, 1.0, 0.8)  # bigger than a shard: a lamp shade
    mesh = with_boxes(base, (floating, (0.12, 0.25, 0.1)), (shoe, (0.25, 0.1, 0.1)), (patch, (0.6, 0.01, 0.6)), (on_wall, (0.02, 0.3, 0.4)), (in_box, (0.1, 0.1, 0.1)), (lamp, (0.4, 0.3, 0.4)))
    out, stats = loose.run(mesh, capture, plan, log=lambda _: None)
    assert boxes_left(out, [floating, shoe, patch, on_wall, in_box, lamp]) == [False, False, True, True, True, True], stats
    assert stats["looseFloating"] == 1 and stats["looseLow"] == 1 and abs(stats["looseArea"] - 0.254) < 0.005, stats
    assert len(out.faces) == len(mesh.faces) - 24, "the room itself is untouched"


def test_without_rooms_nothing_goes(tmp_path):
    room.write(tmp_path)
    capture = load(tmp_path / "capture")
    capture.rooms = []
    mesh = with_boxes(scene.from_model(glb.read((tmp_path / "model.glb").read_bytes())), ((2.2, 1.1, 1.6), (0.12, 0.25, 0.1)))
    out, stats = loose.run(mesh, capture, layout.Layout(), log=lambda _: None)
    assert out is mesh and stats["looseFloating"] == 0


def test_a_piece_the_photos_see_through_goes(tmp_path):
    """A box the scan kept that the photos don't show (someone who walked on), too big for the rules,
    goes once the depth model, which sees the room behind it, has measured the photos; a real box the
    photos show stays."""
    truth = room.write(tmp_path, layout=room.layout_doc())
    capture = load(tmp_path / "capture")
    plan = layout.load(tmp_path / "capture")
    base = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    ghost, real = (0.7, 1.0, 2.3), (2.3, 1.0, 2.3)
    mesh = with_boxes(base, (ghost, (0.28, 0.28, 0.28)), (real, (0.3, 0.3, 0.3)))
    after_rules, _ = loose.run(mesh, capture, plan, log=lambda _: None)
    assert boxes_left(after_rules, [ghost, real]) == [True, True], "too big for the rules"
    # The depth model's answer: the room as it is, with the real box and without the ghost.
    actual = views.Caster.of(with_boxes(truth["mesh"], (real, (0.3, 0.3, 0.3))))
    depths = {}
    for cam in capture.cameras:
        d = actual.view(cam.K, cam.camtoworld, cam.width, cam.height).depth
        depths[cam.name] = (np.where(np.isfinite(d), d, 10.0).astype(np.float32), cam.K)
    out, stats = loose.seen_through(after_rules, capture, plan, depths, log=lambda _: None)
    assert boxes_left(out, [ghost, real]) == [False, True], stats
    assert stats["looseSeenThrough"] == 1 and abs(stats["looseSeenThroughArea"] - 0.47) < 0.01, stats
