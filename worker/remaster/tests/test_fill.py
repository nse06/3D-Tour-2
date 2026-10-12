"""Spots no photo saw, filled in (fill.py)."""

import numpy as np

from atrium_remaster import fill

from . import room


def test_pull_push_fills_holes_smoothly_and_keeps_the_rest():
    image = np.zeros((20, 30, 3), np.float32)
    image[:, :15] = [1, 0, 0]
    image[:, 15:] = [0, 0, 1]
    known = np.ones((20, 30), bool)
    known[5:15, 10:20] = False
    out = fill.pull_push(image, known)
    assert np.allclose(out[known], image[known])
    hole = out[~known]
    assert np.isfinite(hole).all() and hole[:, 0].max() > 0.5 and hole[:, 2].max() > 0.5, "both sides reach into the hole"


def test_uv_rasterization_covers_a_chart_exactly():
    tri = np.array([[[0.0, 0.0], [0.5, 0.0], [0.5, 0.5]], [[0.0, 0.0], [0.5, 0.5], [0.0, 0.5]]])
    mask = fill.rasterize_uv(tri, (10, 10))
    assert mask[:5, :5].all() and not mask[5:].any() and not mask[:, 5:].any()


class Recording:
    name = "recording"

    def __init__(self):
        self.calls = []

    def __call__(self, images, masks):
        self.calls.append((images, masks))
        return [np.where(m[..., None], 255, im).astype(np.uint8) for im, m in zip(images, masks)]


def test_only_flat_charts_with_a_fillable_hole_are_sent(tmp_path):
    truth = room.write(tmp_path)
    mesh = truth["mesh"]
    charts = mesh.charts()
    assert len(fill.flat_charts(mesh, charts, 10.0)) == len(truth["charts"])
    seen = np.ones(mesh.atlases[0].shape[:2], np.float32)
    # A hole in the middle of the far wall (z = 0), a sliver on the floor, and the ceiling entirely unseen.
    wall, floor, ceiling = truth["charts"][2], truth["charts"][0], truth["charts"][1]
    wx0, wy0, _, _ = wall.rect
    seen[wy0 + 40 : wy0 + 60, wx0 + 40 : wx0 + 80] = 0
    fx0, fy0, _, _ = floor.rect
    seen[fy0 + 10 : fy0 + 12, fx0 + 10 : fx0 + 12] = 0
    cx0, cy0, cw, ch = ceiling.rect
    seen[cy0 : cy0 + ch, cx0 : cx0 + cw] = 0
    inpainter = Recording()
    out, stats = fill.fill(mesh, [seen], inpainter, log=lambda _: None)
    assert stats["filledCharts"] == 1, "the wall: the floor's sliver is too small, the ceiling too unseen"
    hole = out.atlases[0][wy0 + 41 : wy0 + 59, wx0 + 41 : wx0 + 79]
    assert np.allclose(hole, 1.0)
    untouched = np.ones(mesh.atlases[0].shape[:2], bool)
    untouched[wy0 + 38 : wy0 + 62, wx0 + 38 : wx0 + 82] = False
    assert np.allclose(out.atlases[0][untouched], mesh.atlases[0][untouched])


def test_texels_the_phone_painted_from_photos_are_never_made_up(tmp_path):
    from atrium_photoreal.capture import load

    truth = room.write(tmp_path)
    mesh = truth["mesh"]
    capture = load(tmp_path / "capture")
    painted = fill.painted_from_photos(mesh, capture.seeds_xyz, capture.seed_spacing)[0]
    ceiling, wall = truth["charts"][1], truth["charts"][3]
    cx0, cy0, cw, ch = ceiling.rect
    wx0, wy0, ww, wh = wall.rect
    # No photo looks up at the ceiling; the walls in front of the cameras are seen nearly everywhere.
    assert painted[cy0 + 4 : cy0 + ch - 4, cx0 + 4 : cx0 + cw - 4].mean() < 0.05
    assert painted[wy0 + 30 : wy0 + wh - 10, wx0 + 10 : wx0 + ww - 10].mean() > 0.9
    # The skins counting nothing on that wall doesn't make it a hole: the phone painted it.
    seen = np.zeros(mesh.atlases[0].shape[:2], np.float32)
    recording = Recording()
    out, stats = fill.fill(mesh, [seen], recording, log=lambda _: None, painted=[painted])
    for images, masks in recording.calls:
        for mask in masks:
            assert mask.sum() < 0.5 * mask.size
    untouched = painted & ~np.isclose(out.atlases[0], 1.0).all(-1)
    assert untouched[painted].mean() > 0.99
