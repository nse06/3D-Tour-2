"""Photos cleaned up before training, and the skins tidied after (cleanup.py, layout.py)."""

import json

import numpy as np

from atrium_photoreal.capture import load
from atrium_remaster import cleanup, glb, job, layout, scene, skins, views

from . import room

FAST = dict(steps=60, batch=4, tile=256, levels=3, max_mip=3, progress_every=0)


def test_the_layout_is_read_and_bad_entries_skipped():
    doc = {"layout": room.layout_doc("television")}
    doc["layout"]["objects"].append({"id": "BAD", "category": "sofa", "center": [0, 0], "size": [1, 1, 1], "axes": [[1, 0, 0]]})
    doc["layout"]["openings"].append({"id": "BAD", "kind": "door", "center": [0, 0, 0], "width": -1, "height": 2, "along": [1, 0, 0], "normal": [0, 0, 1]})
    parsed = layout.parse(doc)
    assert len(parsed.walls) == 4 and len(parsed.openings) == 1 and len(parsed.objects) == 1
    tv = parsed.objects_of("television")[0]
    assert tv.contains(np.array([[1.4, 0.45, 0.25], [1.79, 0.89, 0.49]])).all() and not tv.contains(np.array([[1.9, 0.45, 0.25]]))[0]
    assert np.allclose(parsed.walls[0].inside, [0, 1]), "the z = 0 wall faces into the room"
    assert layout.parse({}).empty, "scans before build 13 have none"


def test_only_smeared_photos_are_sharpened_and_count_less_smear(tmp_path):
    room.write(tmp_path)
    capture = load(tmp_path / "capture")
    sharpened = cleanup.sharpen_photos(capture, cleanup.UnsharpCleaner(), cleanup.CleanupConfig(), long_side=1920, log=lambda _: None)
    assert sorted(sharpened) == ["000003", "000008"], "the two photos taken while turning"
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    cfg = skins.SkinConfig(**FAST)
    plain = {v.name: v for v in skins.prepare_photos(mesh, capture, cfg, log=lambda _: None)}
    clean = {v.name: v for v in skins.prepare_photos(mesh, capture, cfg, photos=sharpened, residual=0.3, log=lambda _: None)}
    assert plain["000003"].smear > 3 and abs(clean["000003"].smear - 0.3 * plain["000003"].smear) < 1e-6
    assert clean["000000"].smear == plain["000000"].smear == 0
    assert not np.allclose(clean["000003"].image.numpy(), plain["000003"].image.numpy())
    assert np.allclose(clean["000000"].image.numpy(), plain["000000"].image.numpy())


def test_a_tv_screen_says_nothing_and_comes_out_off(tmp_path):
    truth = room.write(tmp_path, layout=room.layout_doc("television"))
    mesh = truth["mesh"]
    tv = layout.load(tmp_path / "capture").objects_of("television")
    screens = cleanup.screen_faces(mesh, tv)
    # The cabinet's front (facing +z, its thin axis) and nothing else: not its top or sides, not the wall.
    chart = np.repeat(np.arange(len(truth["charts"])), 2)
    assert set(chart[screens]) == {6}
    capture = load(tmp_path / "capture")
    cfg = skins.SkinConfig(**FAST)
    quiet = skins.prepare_photos(mesh, capture, cfg, quiet_faces=screens, log=lambda _: None)
    caster = views.Caster.of(mesh)
    for view, cam in zip(quiet, capture.cameras):
        hits = caster.view(cam.K, cam.camtoworld, cam.width, cam.height)
        on_screen = hits.hit & screens[np.where(hits.hit, hits.face, 0)]
        assert not view.valid.numpy()[on_screen].any()
    tidy, stats = cleanup.tidy_skins(mesh, layout.load(tmp_path / "capture"), cleanup.CleanupConfig(windows=False), log=lambda _: None)
    assert stats["tvsOff"] == 1
    x0, y0, w, h = truth["charts"][6].rect
    front = tidy.atlases[0][y0 + 4 : y0 + h - 4, x0 + 4 : x0 + w - 4]
    assert np.allclose(front, cleanup.CleanupConfig().tv_color, atol=1e-6)
    x0, y0, w, h = truth["charts"][7].rect
    assert np.allclose(tidy.atlases[0][y0 : y0 + h, x0 : x0 + w], mesh.atlases[0][y0 : y0 + h, x0 : x0 + w]), "the cabinet's top is untouched"


def test_dark_window_glass_is_brightened_and_its_frame_kept(tmp_path):
    truth = room.write(tmp_path, layout=room.layout_doc())
    mesh = truth["mesh"]
    lay = layout.load(tmp_path / "capture")
    pos, face_of = cleanup.atlas_positions(mesh)[0]
    window = lay.openings[0]
    mask = cleanup.window_mask(pos, face_of, mesh.face_normals, window)
    assert 0.9 * 50 * 50 < mask.sum() < 1.1 * 50 * 50, "a 1 m window at 2 cm texels"
    night = mesh.atlases[0].copy()
    night[mask] = 0.03  # black glass
    ys, xs = np.nonzero(mask)
    mid_row = int(np.median(ys))
    night[mid_row, xs.min() : xs.max() + 1][mask[mid_row, xs.min() : xs.max() + 1]] = 0.8  # a light mullion across it
    dark = scene.Mesh(mesh.vertices, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, [night], mesh.extras)
    tidy, stats = cleanup.tidy_skins(dark, lay, cleanup.CleanupConfig(tv_off=False), log=lambda _: None)
    assert stats["windowsBrightened"] == 1
    out = tidy.atlases[0]
    glass = mask.copy()
    glass[mid_row] = False
    assert out[glass].mean() > 0.75, "black glass becomes daylight"
    assert np.allclose(out[mid_row][mask[mid_row]], 0.8), "the mullion stays"
    assert np.allclose(out[~mask], night[~mask]), "nothing outside the window changes"


def test_the_job_cleans_up_with_a_layout(tmp_path):
    room.write(tmp_path, layout=room.layout_doc("television"))
    capture = load(tmp_path / "capture")
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    services = job.Services(cleaner=cleanup.UnsharpCleaner())
    options = {"steps": 60, "batch": 4, "tile": 256, "levels": 3, "maxMip": 3}
    out, stats = job.remaster(mesh, capture, options, services, "cpu", lambda *a: None, log=lambda _: None, layout=layout.load(tmp_path / "capture"))
    assert stats["layout"] and stats["photosSharpened"] == 2 and stats["tvsOff"] == 1
    assert json.dumps(stats)


def test_the_job_sets_the_window_into_its_wall(tmp_path):
    room.write(tmp_path, layout=room.layout_doc())
    capture = load(tmp_path / "capture")
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    options = {"steps": 40, "batch": 4, "tile": 256, "levels": 3, "maxMip": 3}
    out, stats = job.remaster(mesh, capture, options, job.Services(), "cpu", lambda *a: None, log=lambda _: None, layout=layout.load(tmp_path / "capture"))
    assert stats["recessed"] == 1 and stats["newAtlas"] >= 16 and len(out.atlases) == 2
