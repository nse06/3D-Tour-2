"""Sharper depth from AI keeps photos from painting across the model's shapes (depth.py)."""

import numpy as np

from atrium_photoreal.capture import load
from atrium_remaster import depth, glb, scene, skins, views

from . import room

FAST = dict(steps=40, batch=4, tile=256, levels=3, max_mip=3, progress_every=0)


class PlantInFront:
    """A depth model that sees something 60 cm in front of the wall in the middle of every photo (a
    plant the scan didn't keep)."""

    name = "plant"

    def __call__(self, images, prompts):
        out = depth.PromptAsDepth()(images, prompts)
        for d in out:
            h, w = d.shape
            d[h // 3 : 2 * h // 3, w // 3 : 2 * w // 3] -= 0.6
        return out


def test_the_models_depth_is_what_lidar_would_report(tmp_path):
    truth = room.write(tmp_path, cameras=4)
    capture = load(tmp_path / "capture")
    caster = views.Caster.of(truth["mesh"])
    cam = capture.cameras[0]
    coarse = depth.model_depth(caster, cam.K, cam.camtoworld, cam.width, cam.height, (64, 48))
    full = caster.view(cam.K, cam.camtoworld, cam.width, cam.height).depth
    assert coarse.shape == (48, 64) and np.isfinite(coarse).all()
    assert abs(float(np.median(coarse)) - float(np.median(full))) < 0.05


def test_pixels_where_the_depth_disagrees_say_nothing(tmp_path):
    room.write(tmp_path, cameras=6)
    capture = load(tmp_path / "capture")
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    cfg = depth.DepthConfig(long_side=160, prompt_size=(64, 48))
    agree = depth.disagreements(mesh, capture, depth.PromptAsDepth(), cfg, log=lambda _: None)
    # The model's own depth, coarse and scaled up, agrees with itself but for a thin band along the
    # cabinet's outline (where scaling up blurs the jump).
    assert np.mean([m.mean() for m in agree.values()]) < 0.06
    plant = depth.disagreements(mesh, capture, PlantInFront(), cfg, log=lambda _: None)
    mask = plant[capture.cameras[0].name]
    h, w = mask.shape
    assert mask[h // 3 + 3 : 2 * h // 3 - 3, w // 3 + 3 : 2 * w // 3 - 3].all() and not mask[: h // 4].any()
    skin_cfg = skins.SkinConfig(**FAST)
    plain = skins.prepare_photos(mesh, capture, skin_cfg, log=lambda _: None)
    masked = skins.prepare_photos(mesh, capture, skin_cfg, disagree=plant, log=lambda _: None)
    for a, b in zip(plain, masked):
        v = b.valid.numpy()
        H, W = v.shape
        assert not v[H // 3 + 3 : 2 * H // 3 - 3, W // 3 + 3 : 2 * W // 3 - 3].any()
        assert (a.valid.numpy() & ~v).sum() > 0 and not (v & ~a.valid.numpy()).any()
