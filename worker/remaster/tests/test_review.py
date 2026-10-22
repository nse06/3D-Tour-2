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
        self.photos = []

    def __call__(self, photo, rendered):
        self.calls += 1
        self.photos.append(photo)
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
    assert verdict.issues[0].piece == "CAB" and verdict.issues[0].outcome == "to be rebuilt as a box"
    # A sofa's box takes in its back cushions: boxy or not, a sofa is made by the shape maker.
    plan.objects[:] = [review.Box(b.id, "sofa", b.center, b.axes, b.size) if b.id == "CAB" else b for b in plan.objects]
    seen.clear()
    spotter.calls = 0
    _, verdict = review.inspect(mesh, capture, plan, spotter, cfg, log=lambda _: None)
    assert verdict.rebuild == {"CAB": "made"}, verdict
    sink = review.Box("SINK", "sink", cabinet.center + np.array([1.0, 0, 0]), np.eye(3), np.array([0.6, 0.9, 0.5]))
    assert review.built_in(cabinet, layout.Layout(objects=[cabinet, sink]), 1.0) and not review.built_in(cabinet, plan, 1.0)


def test_a_box_drawn_tight_around_a_hole_still_finds_its_piece(tmp_path, monkeypatch):
    """The reviewer boxes the hole in the cabinet's front, not the cabinet: far too small to match the
    cabinet's outline, but what it shows is the cabinet, so the cabinet is made again. A box on the
    bare wall finds nothing, and says so."""
    capture, plan, mesh = setup(tmp_path)
    cabinet = next(b for b in plan.objects if b.id == "CAB")
    seen = []
    make = review.make_views
    monkeypatch.setattr(review, "make_views", lambda *a, **k: seen.extend(make(*a, **k)) or list(seen))
    hits = []

    def spotter(photo, rendered):
        view = seen[spotter.calls % len(seen)]
        spotter.calls += 1
        outline = review.projected_box(cabinet, view)
        if outline is None or not (view.box_of >= 0).any():
            return []
        ys, xs = np.nonzero(view.box_of >= 0)
        h, w = view.box_of.shape
        cx, cy = xs.mean() / w, ys.mean() / h
        hole = (cx - 0.02, cy - 0.02, cx + 0.02, cy + 0.02)
        hits.append(review.iou(outline, hole))
        return [review.Issue("incomplete", "cabinet with a hole", hole, "rebuild", "high", True, "storage"),
                review.Issue("incomplete", "sofa with a hole", hole, "rebuild", "high", True, "sofa"),
                review.Issue("incomplete", "patch of wall", (0.0, 0.0, 0.05, 0.05), "rebuild", "high")]

    spotter.calls = 0
    _, verdict = review.inspect(mesh, capture, plan, spotter, review.ReviewConfig(views=6, long_side=160, workers=1), log=lambda _: None)
    assert hits and max(hits) < review.ReviewConfig().rebuild_share, "outlines alone wouldn't have found it"
    assert verdict.rebuild == {"CAB": "box"}, verdict
    assert {i.outcome for i in verdict.issues if i.what in ("patch of wall", "sofa with a hole")} == {"left: no furniture piece RoomPlan measured there"}, "a sofa's problem never lands on a cabinet"
    review.rebuilt(verdict, ["CAB"])
    assert review.summary(verdict.issues)[0] == "incomplete: cabinet with a hole (rebuilt as a box)"
    review.rebuilt(verdict, [])
    assert review.summary(verdict.issues)[0] == "incomplete: cabinet with a hole (tried, but the scan stayed)"


def test_a_point_on_the_piece_or_a_loose_box_around_it_finds_it(tmp_path, monkeypatch):
    """The reviewer's boxes can be off: a point on the cabinet finds it even with its box elsewhere,
    and a box twice the cabinet's size each way (most of it wall and floor) still takes in all of it."""
    capture, plan, mesh = setup(tmp_path)
    seen = []
    make = review.make_views
    monkeypatch.setattr(review, "make_views", lambda *a, **k: seen.extend(make(*a, **k)) or list(seen))
    shown = []

    def spotter(photo, rendered):
        view = seen[spotter.calls % len(seen)]
        spotter.calls += 1
        if (view.box_of >= 0).sum() < 200:
            return []
        ys, xs = np.nonzero(view.box_of >= 0)
        h, w = view.box_of.shape
        x0, x1, y0, y1 = xs.min() / w, (xs.max() + 1) / w, ys.min() / h, (ys.max() + 1) / h
        cx, cy, dx, dy = (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0
        loose = (max(0.0, cx - dx), max(0.0, cy - dy), min(1.0, cx + dx), min(1.0, cy + dy))
        shown.append(view.index)
        return [review.Issue("incomplete", "pointed at", (0.0, 0.0, 0.03, 0.03), "rebuild", "high", True, "storage", (xs.mean() / w, ys.mean() / h)),
                review.Issue("incomplete", "loosely boxed", loose, "rebuild", "high", True, "storage")]

    spotter.calls = 0
    logs = []
    _, verdict = review.inspect(mesh, capture, plan, spotter, review.ReviewConfig(views=6, long_side=160, workers=1), log=logs.append)
    assert shown and verdict.rebuild == {"CAB": "box"}, (verdict, logs)
    assert all(i.piece == "CAB" for i in verdict.issues), [(i.what, i.outcome) for i in verdict.issues]
    assert any("(by its point; point at [" in line for line in logs) and any("(by its box;" in line for line in logs), logs


def test_a_built_in_cabinet_is_left_and_says_so(tmp_path, monkeypatch):
    """Kitchen cabinets (storage beside a sink) are never rebuilt: the problem says why it's left."""
    doc = room.layout_doc()
    doc["objects"].append({"id": "SINK", "category": "sink", "center": [2.6, 0.45, 0.25], "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "size": [0.6, 0.9, 0.5]})
    room.write(tmp_path, layout=doc)
    capture, plan = load(tmp_path / "capture"), layout.load(tmp_path / "capture")
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    cabinet = next(b for b in plan.objects if b.id == "CAB")
    seen = []
    make = review.make_views
    monkeypatch.setattr(review, "make_views", lambda *a, **k: seen.extend(make(*a, **k)) or list(seen))

    def spotter(photo, rendered):
        view = seen[spotter.calls % len(seen)]
        spotter.calls += 1
        outline = review.projected_box(cabinet, view)
        if outline is None:
            return []
        point = ((outline[0] + outline[2]) / 2, (outline[1] + outline[3]) / 2)
        return [review.Issue("incomplete", "white cabinet", outline, "rebuild", "high", True, "storage", point)]

    spotter.calls = 0
    _, verdict = review.inspect(mesh, capture, plan, spotter, review.ReviewConfig(views=6, long_side=160, workers=1), log=lambda _: None)
    assert verdict.issues and verdict.rebuild == {}, verdict
    assert {i.outcome for i in verdict.issues} == {"left: built in (kitchen and bath cabinets aren't rebuilt)"}


def test_the_photos_reviewed_show_every_piece_of_furniture(tmp_path):
    """Photos picked evenly along the walk can all miss a piece: the first picked shows the most
    furniture not yet shown, the most of it on a tie."""
    capture, plan, mesh = setup(tmp_path)
    cabinet = next(b for b in plan.objects if b.id == "CAB")
    cfg = review.ReviewConfig(views=1, long_side=160)
    sharp = review.pick_cameras(capture, review.ReviewConfig(views=99, long_side=160))
    shows = review.furniture_shown(mesh, sharp, [cabinet], cfg)
    assert any(0 in s for s in shows) and any(0 not in s for s in shows), "some photos show the cabinet, some don't"
    (picked,) = review.pick_cameras(capture, cfg, mesh, [cabinet])
    assert picked is sharp[max(range(len(sharp)), key=lambda i: shows[i].get(0, 0))]
    assert review.pick_cameras(capture, cfg) == [sharp[0]], "without furniture, evenly along the walk"


class PieceChecker:
    """Finds nothing looking over the home; asked about one outlined piece, says what it's told to
    (and keeps the crops it was shown)."""

    name = "stub"

    def __init__(self, broken: bool):
        self.broken, self.shown = broken, []

    def __call__(self, photo, rendered):
        return []

    def check_piece(self, photo, rendered):
        self.shown.append((photo, rendered))
        return {"closed_box": True, "broken": self.broken, "sure": "high"}


def test_each_dresser_and_cabinet_is_checked_on_its_own(tmp_path):
    """Looking over the home, the reviewer noticed a real dresser one run and missed it the next:
    asked about each piece on its own (outlined in the photo showing most of it), a broken closed box
    is made again as RoomPlan's box, whether or not the open look noticed it."""
    capture, plan, mesh = setup(tmp_path)
    cfg = review.ReviewConfig(views=6, long_side=160, workers=1)
    for broken, rebuild in ((True, {"CAB": "box"}), (False, {})):
        checker = PieceChecker(broken)
        _, verdict = review.inspect(mesh, capture, plan, checker, cfg, log=lambda _: None)
        assert verdict.rebuild == rebuild, verdict
        assert len(checker.shown) == 1, "one question for the one cabinet"
        photo, rendered = checker.shown[0]
        magenta = lambda im: ((im[..., 0] > 200) & (im[..., 1] < 60) & (im[..., 2] > 200)).sum()
        assert magenta(photo) > 20 and magenta(rendered) > 20, "outlined on both"
    _, verdict = review.inspect(mesh, capture, plan, PieceChecker(True), cfg, log=lambda _: None)
    (issue,) = verdict.issues
    assert issue.piece == "CAB" and issue.outcome == "to be rebuilt as a box" and issue.what.startswith("dresser or cabinet")


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
        {"kind": "incomplete", "what": "wooden dresser", "box": [8, 24, 40, 45], "point": [16, 36], "fix": "rebuild", "sure": "high", "boxy": True, "furniture": "storage"},
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
    assert issues[0].box == (0.125, 0.5, 0.625, 0.9375) and issues[0].point == (0.25, 0.75), "the render's pixels (64x48), as 0-1 of it"
    assert issues[0].boxy and issues[0].furniture == "storage"
    assert "64x48 pixels" in request["messages"][0]["content"][-1]["text"]
    assert reviewer.usage() == {"input": 2600, "output": 1500, "dollars": 0.04}, "what it cost, counted"
    assert review.ClaudeReviewer(client=FakeClient(stop="refusal"))(photo, photo) == []


def test_claude_is_asked_about_one_piece_at_low_effort():
    client = FakeClient(json.dumps({"closed_box": True, "broken": True, "sure": "medium"}))
    reviewer = review.ClaudeReviewer(client=client)
    crop = np.zeros((40, 60, 3), np.uint8)
    assert reviewer.check_piece(crop, crop) == {"closed_box": True, "broken": True, "sure": "medium"}
    (request,) = client.requests
    assert request["output_config"]["effort"] == "low" and request["output_config"]["format"]["schema"] == review.PIECE_SCHEMA
    assert request["system"] == review.PIECE_SYSTEM and sum(c["type"] == "image" for c in request["messages"][0]["content"]) == 2
    assert review.ClaudeReviewer(client=FakeClient(stop="refusal")).check_piece(crop, crop) is None


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
    assert stats["reviewRemoved"] == 1 and stats["reviewFound"] == ["fragment: grey box in the air (removed)"], stats
    assert stats["reviewLeft"] == [] and spotter.calls == 2 * review.ReviewConfig().views, "the result checked too (10 photos each time), and it's clean"
    assert len({p.tobytes() for p in spotter.photos}) == review.ReviewConfig().views, "the same photos both times: no more go to the reviewer"
    assert boxes_left(out, [GHOST]) == [False]


def test_the_selftest_says_whether_the_reviewer_answers():
    answer = {"issues": [
        {"kind": "fragment", "what": "dark piece in the air", "box": [58, 58, 102, 112], "point": [80, 85], "fix": "remove", "sure": "high", "boxy": False, "furniture": "none"},
        {"kind": "incomplete", "what": "dresser with a hole", "box": [230, 190, 300, 240], "point": [265, 215], "fix": "rebuild", "sure": "high", "boxy": True, "furniture": "storage"},
    ]}
    result = review.selftest(review.ClaudeReviewer(client=FakeClient(json.dumps(answer))))
    assert result["ok"] and result["fixes"] == ["rebuild", "remove"] and result["boxy"] and result["tokens"]["input"] == 2 * 2600, result
    assert result["piece"] == {"closed_box": False, "broken": False, "sure": "medium"}, "the one-piece question asked too (the recorded answer has none of its fields)"
    fragment, dresser = result["aim"]
    assert fragment["boxIoU"] > 0.8 and fragment["pointOnIt"], "it aimed true at the fragment"
    assert dresser["boxIoU"] < 0.2 and dresser["pointOnIt"], "its box is the hole, not the dresser (asked for the whole), its point on the dresser"

    class Broken:
        def __call__(self, photo, rendered):
            raise PermissionError("invalid x-api-key")

    assert review.selftest(Broken()) == {"ok": False, "why": "PermissionError: invalid x-api-key"}
