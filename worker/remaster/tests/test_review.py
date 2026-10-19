"""The AI reviewer (review.py): what it says is wrong is fixed, by stages that can fix it."""

import json
from types import SimpleNamespace

import numpy as np

from atrium_photoreal.capture import load
from atrium_remaster import glb, layout, review, scene

from . import room
from .test_loose import boxes_left, with_boxes

GHOST = (0.7, 1.0, 2.3)
GREY = 77  # with_boxes' flat 0.3, as rendered


class GhostSpotter:
    """Flags what the render shows in flat grey that the photo doesn't: a fragment to remove."""

    name = "stub"

    def __init__(self):
        self.calls = 0

    def __call__(self, photo, rendered):
        self.calls += 1
        ghost = (np.abs(rendered.astype(int) - GREY).max(-1) <= 3) & (np.abs(rendered.astype(int) - photo.astype(int)).sum(-1) > 60)
        if ghost.sum() < 30:
            return []
        ys, xs = np.nonzero(ghost)
        h, w = ghost.shape
        return [review.Issue("fragment", "grey box in the air", (xs.min() / w, ys.min() / h, (xs.max() + 1) / w, (ys.max() + 1) / h), "remove", "high")]


def setup(tmp_path, *boxes):
    room.write(tmp_path, layout=room.layout_doc())
    capture = load(tmp_path / "capture")
    plan = layout.load(tmp_path / "capture")
    mesh = with_boxes(scene.from_model(glb.read((tmp_path / "model.glb").read_bytes())), *boxes)
    return capture, plan, mesh


def test_a_fragment_the_reviewer_points_at_goes(tmp_path):
    capture, plan, mesh = setup(tmp_path, (GHOST, (0.28, 0.28, 0.28)))
    spotter = GhostSpotter()
    cfg = review.ReviewConfig(views=16, long_side=160)
    out, verdict = review.inspect(mesh, capture, plan, spotter, cfg, log=lambda _: None)
    assert spotter.calls == len(capture.cameras) - 2 and verdict.issues, "every sharp photo shown (room.write smears two), and the ghost seen"
    assert verdict.removed == 1 and boxes_left(out, [GHOST]) == [False]
    assert len(out.faces) == len(mesh.faces) - 12, "nothing else goes"


def test_furniture_it_finds_broken_is_made_again_but_not_built_ins(tmp_path, monkeypatch):
    """The reviewer says the cabinet has a hole: it's listed for the furniture stage, which makes it
    again (and keeps it only if it matches the photos better). Next to a sink, a cabinet is built in."""
    capture, plan, mesh = setup(tmp_path)
    cabinet = next(b for b in plan.objects if b.id == "CAB")
    seen = []
    make = review.make_views
    monkeypatch.setattr(review, "make_views", lambda *a, **k: seen.extend(make(*a, **k)) or list(seen))

    def spotter(photo, rendered):
        view = seen[spotter.calls % len(seen)]
        spotter.calls += 1
        outline = review.projected_box(cabinet, view)
        return [review.Issue("incomplete", "cabinet with a hole", outline, "rebuild", "high", spotter.boxy)] if outline else []

    cfg = review.ReviewConfig(views=6, long_side=160, workers=1)
    for boxy, made in ((False, "made"), (True, "box")):
        seen.clear()
        spotter.calls, spotter.boxy = 0, boxy
        _, verdict = review.inspect(mesh, capture, plan, spotter, cfg, log=lambda _: None)
        assert verdict.rebuild == {"CAB": made}, verdict
    sink = review.Box("SINK", "sink", cabinet.center + np.array([1.0, 0, 0]), np.eye(3), np.array([0.6, 0.9, 0.5]))
    assert review.built_in(cabinet, layout.Layout(objects=[cabinet, sink]), 1.0) and not review.built_in(cabinet, plan, 1.0)


class FakeClient:
    """Records the request; answers with `text` (or a refusal)."""

    def __init__(self, text=None, stop="end_turn"):
        self.requests = []
        usage = SimpleNamespace(input_tokens=2600, output_tokens=1500)
        self.answer = SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="text", text=text or "")], usage=usage)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **request):
        self.requests.append(request)
        return self.answer


def test_claude_is_asked_with_both_images_and_answers_in_boxes():
    answer = {"issues": [
        {"kind": "incomplete", "what": "wooden dresser", "box": [100, 500, 600, 900], "fix": "rebuild", "sure": "high", "boxy": True},
        {"kind": "smear", "what": "painting", "box": [300, 100, 300, 200], "fix": "repaint", "sure": "medium"},  # empty box: dropped
        {"kind": "nonsense", "what": "?", "box": [0, 0, 10, 10], "fix": "none", "sure": "low"},  # unknown kind: dropped
    ]}
    client = FakeClient(json.dumps(answer))
    reviewer = review.ClaudeReviewer(client=client)
    photo = np.zeros((48, 64, 3), np.uint8)
    issues = reviewer(photo, photo + 128)
    (request,) = client.requests
    assert request["model"] == "claude-opus-5-5" and request["fallbacks"] == "default" and request["betas"] == ["server-side-fallback-2026-07-01"]
    assert request["output_config"]["format"]["schema"] == review.SCHEMA and request["output_config"]["effort"] == "medium"
    images = [c for c in request["messages"][0]["content"] if c["type"] == "image"]
    assert len(images) == 2 and all(i["source"]["media_type"] == "image/jpeg" for i in images)
    assert [(i.kind, i.what, i.fix) for i in issues] == [("incomplete", "wooden dresser", "rebuild")]
    assert issues[0].box == (0.1, 0.5, 0.6, 0.9) and issues[0].boxy
    assert reviewer.usage() == {"input": 2600, "output": 1500, "dollars": 0.04}, "what it cost, counted"
    assert review.ClaudeReviewer(client=FakeClient(stop="refusal"))(photo, photo) == []


def test_without_a_key_there_is_no_reviewer(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert review.reviewer_from_env(log=lambda _: None) is None
    assert review.summary([review.Issue("wrong_shape", "armchair", (0, 0, 1, 1), "rebuild", "high")] * 2) == ["wrong shape: armchair"]


def test_the_job_reviews_the_scan_first_and_the_result_last(tmp_path):
    from atrium_remaster.job import Services, remaster

    capture, plan, mesh = setup(tmp_path, (GHOST, (0.28, 0.28, 0.28)))
    spotter = GhostSpotter()
    options = {"steps": 10, "batch": 2, "tile": 128, "longSide": 160, "fill": False, "trim": False, "fixerViews": False, "depth": False, "loose": False}
    out, stats = remaster(mesh, capture, options, Services(reviewer=spotter), "cpu", lambda *a: None, log=lambda _: None, layout=plan)
    assert stats["reviewRemoved"] == 1 and stats["reviewFound"] == ["fragment: grey box in the air"], stats
    assert stats["reviewLeft"] == [] and spotter.calls == 2 * review.ReviewConfig().views, "the result checked too (8 photos each time), and it's clean"
    assert boxes_left(out, [GHOST]) == [False]


def test_the_selftest_says_whether_the_reviewer_answers():
    answer = {"issues": [
        {"kind": "fragment", "what": "dark piece in the air", "box": [110, 150, 200, 290], "fix": "remove", "sure": "high", "boxy": False},
        {"kind": "incomplete", "what": "dresser with a hole", "box": [440, 490, 590, 630], "fix": "rebuild", "sure": "high", "boxy": True},
    ]}
    result = review.selftest(review.ClaudeReviewer(client=FakeClient(json.dumps(answer))))
    assert result["ok"] and result["fixes"] == ["rebuild", "remove"] and result["boxy"] and result["tokens"]["input"] == 2600, result

    class Broken:
        def __call__(self, photo, rendered):
            raise PermissionError("invalid x-api-key")

    assert review.selftest(Broken()) == {"ok": False, "why": "PermissionError: invalid x-api-key"}
