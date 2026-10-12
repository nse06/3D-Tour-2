"""Changes to the model's shapes (edit.py): out with some triangles, in with new ones that the skins
learn from the photos."""

import numpy as np

from atrium_photoreal.capture import load
from atrium_remaster import edit, glb, scene, skins, views

from . import room

FAST = dict(steps=120, batch=4, tile=256, levels=3, max_mip=3, progress_every=0, lr=0.03)


def test_a_box_is_wound_outward():
    corners, faces = edit.box(np.zeros(3), np.eye(3), np.array([2.0, 1.0, 0.5]))
    a, b, c = (corners[faces[:, k]] for k in range(3))
    n = np.cross(b - a, c - a)
    assert ((n * (a + b + c) / 3).sum(-1) > 0).all()
    assert len(faces) == 12


def test_a_replaced_cabinet_gets_its_own_texels_and_learns_them(tmp_path):
    truth = room.write(tmp_path)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    chart = np.repeat(np.arange(len(truth["charts"])), 2)
    cabinet = (chart >= 6) & (chart <= 9)
    corners, faces = edit.box(np.array([1.4, 0.45, 0.25]), np.eye(3), np.array([0.8, 0.9, 0.5]))
    edited, stats = edit.apply(mesh, cabinet, [edit.Addition(corners, faces, color=(0.5, 0.5, 0.5), name="cabinet")])
    assert stats["removedTriangles"] == 8 and stats["addedTriangles"] == 12 and len(edited.atlases) == 2
    new = edited.face_atlas == 1
    assert new.sum() == 12 and (edited.uvs[edited.faces[new]] >= 0).all() and (edited.uvs[edited.faces[new]] <= 1).all()
    assert 6 <= stats["newTexelMm"] <= 30, "at about the model's texel size"
    # The new texels start gray, and the photos teach them the cabinet's front.
    capture = load(tmp_path / "capture")
    cfg = skins.SkinConfig(**FAST)
    result = skins.train(edited, skins.prepare_photos(edited, capture, cfg, log=lambda _: None), cfg, log=lambda _: None)
    caster = views.Caster.of(edited)
    from atrium_photoreal.enhance import look

    pose = look(np.array([1.4, 1.2, 1.6]), 0.0, -0.35)
    hits = caster.view(truth["K"], pose, room.W, room.H)
    # The same shape, so the truth there is the original room's.
    exact = room.truth_color(truth["charts"], truth["mesh"], views.Caster.of(truth["mesh"]).view(truth["K"], pose, room.W, room.H))
    cab = hits.hit & new[np.where(hits.hit, hits.face, 0)]
    assert cab.sum() > 500, "the view sees the new cabinet"
    before = np.abs(views.render(edited, hits)[cab] - exact[cab]).mean()
    after = np.abs(views.render(result.mesh, hits)[cab] - exact[cab]).mean()
    assert after < 0.6 * before, (before, after)
