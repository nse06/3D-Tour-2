"""The AI-enhanced version (enhance.py): views where buyers walk, cleaned up by a fixer, trained on
after the faithful version is delivered. A stand-in fixer here; the real one (NVIDIA Fixer) needs a
GPU (modal_app.py).  Run: cd worker/photoreal && python -m pytest tests -q"""

import json
import math
import struct

import numpy as np
import pytest
import torch

from atrium_photoreal.capture import load
from atrium_photoreal.enhance import AIVersion, EnhanceConfig, SmoothingFixer, between, choose_views, heading, look
from atrium_photoreal.train import TrainConfig, train

from . import scene

TINY = dict(steps=20, long_side=32, sh_degree=0, progress_every=10, max_gaussians=50_000)
AI = dict(rounds=2, steps_per_round=6, views=8, width=64, height=36)


def test_look_and_heading_agree_with_photo_spots():
    for yaw, pitch in [(0.0, 0.0), (math.pi / 2, 0.2), (-2.5, -0.4)]:
        m = look([1.0, 1.5, 2.0], yaw, pitch)
        assert np.allclose(m[:3, :3] @ m[:3, :3].T, np.eye(3), atol=1e-9) and np.linalg.det(m[:3, :3]) > 0
        assert np.allclose(heading(m), (yaw, pitch), atol=1e-9)
    # OpenCV: yaw 0 looks along -z, with x to the right and y down.
    m = look([0, 0, 0], 0.0, 0.0)
    assert np.allclose(m[:3, 2], [0, 0, -1]) and np.allclose(m[:3, 0], [1, 0, 0]) and np.allclose(m[:3, 1], [0, -1, 0])


def add_wall(folder, x=2.1, spacing=0.05):
    """A wall at x = const across the tiny room (seeds facing -x), appended to seeds.ply."""
    raw = (folder / "seeds.ply").read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    count = int(next(line for line in raw[:end].decode().splitlines() if line.startswith("element vertex")).split()[-1])
    ys, zs = np.arange(0, 2.5, spacing), np.arange(0, 3, spacing)
    wall = [(x, y, z) for y in ys for z in zs]
    body = raw[end:] + b"".join(struct.pack("<6f3B", *p, -1, 0, 0, 200, 200, 200) for p in wall)
    header = raw[:end].decode().replace(f"element vertex {count}", f"element vertex {count + len(wall)}")
    (folder / "seeds.ply").write_bytes(header.encode() + body)


def test_views_start_at_the_photos_and_end_where_buyers_walk(tmp_path):
    folder = scene.write(tmp_path / "capture", cameras=12)
    add_wall(folder)
    capture = load(folder)
    cfg = EnhanceConfig(views=30)
    views = choose_views(capture, cfg, np.random.default_rng(0))
    assert 10 <= len(views) <= 30
    assert len({v.photo for v in views}) >= 8, "spread over the photos"
    for v in views:
        start, end = v.start[:3, 3], v.end[:3, 3]
        assert np.allclose(between(v, 0.0)[:3, 3], start) and np.allclose(between(v, 1.0), v.end)
        assert cfg.min_offset - 1e-9 <= np.hypot(*(end - start)[[0, 2]]) <= cfg.max_offset + 1e-9
        assert 0 < end[0] < 3 and 0 < end[2] < 3, "inside the room"
        assert 1.35 <= end[1] <= 1.65, "at eye height above the floor"
        # Not through the wall at x = 2.1, and clear of it.
        assert (start[0] < 2.1) == (end[0] < 2.1) and abs(end[0] - 2.1) > cfg.clearance
        yaw0, _ = heading(v.start)
        yaw1, pitch1 = heading(v.end)
        assert abs((yaw1 - yaw0 + math.pi) % (2 * math.pi) - math.pi) <= math.radians(cfg.max_turn) + 1e-9
        assert abs(pitch1) < math.radians(0.5 * 52 + 6), "nearly level"


def test_without_room_the_views_stay_at_the_photos_height(tmp_path):
    folder = scene.write(tmp_path / "capture", cameras=8)
    doc = json.loads((folder / "cameras.json").read_text())
    doc["rooms"] = []
    (folder / "cameras.json").write_text(json.dumps(doc))
    views = choose_views(load(folder), EnhanceConfig(views=10), np.random.default_rng(1))
    assert views and all(abs(v.end[1, 3] - v.start[1, 3]) <= 0.1 + 1e-9 for v in views)


def test_the_faithful_version_comes_first_and_is_the_same_as_without_ai(tmp_path):
    capture = load(scene.write(tmp_path / "capture", cameras=8))
    plain = train(capture, TrainConfig(**TINY), device="cpu", log=lambda _: None)
    main, progress = [], []
    fixer = SmoothingFixer()
    seen = []

    def counting(images):
        seen.append(len(images))
        assert all(im.shape == (36, 64, 3) and im.dtype == np.uint8 for im in images)
        return fixer(images)

    counting.name = "counting"
    ai = AIVersion(fixer=counting, config=EnhanceConfig(**AI), on_main=main.append)
    result = train(capture, TrainConfig(**TINY), device="cpu", log=lambda _: None, ai=ai, ai_progress=lambda v, m: progress.append(v))
    assert len(main) == 1 and main[0].stats["steps"] == 20
    for k in plain.splats:
        assert torch.allclose(main[0].splats[k], plain.splats[k]), f"faithful {k} differs from training without the AI phase"
    assert result.stats["variant"] == "ai" and result.stats["steps"] == 32 and result.stats["fixer"] == "counting"
    assert len(seen) == 2 and seen[0] == seen[1] == result.stats["aiViews"] > 0, "one clean-up per round, every view"
    assert result.stats["aiCleanedViews"] == 2 * result.stats["aiViews"]
    assert progress and progress[-1] == pytest.approx(1.0)
    assert not torch.allclose(result.splats["sh0"], main[0].splats["sh0"]), "the AI phase trains on"


def test_a_fixer_answering_the_wrong_size_is_caught(tmp_path):
    capture = load(scene.write(tmp_path / "capture", cameras=6))

    def bad(images):
        return [im[:10] for im in images]

    bad.name = "bad"
    main = []
    with pytest.raises(RuntimeError, match="fixer answered"):
        train(capture, TrainConfig(**TINY), device="cpu", log=lambda _: None, ai=AIVersion(fixer=bad, config=EnhanceConfig(**AI), on_main=main.append))
    assert len(main) == 1, "the faithful version was delivered before"
