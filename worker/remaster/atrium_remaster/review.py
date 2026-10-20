"""The AI reviewer (docs/remaster.md §4.9): a vision model looks at the model the way a buyer would, says
what's wrong, and the stages that can fix it do.

Every other AI here is a specialist: SAM cuts a piece out of a photo, the depth model measures, TripoSG
makes one shape from one photo, LaMa fills a patch. None of them looks at the home and asks whether it
makes sense: a dresser with a hole in it, a fragment hanging in the air, a smear across a painting.
Claude does. Shown a photo and the model rendered from the same camera, it lists what the model gets
wrong, where (a box on the render) and what the thing should be. Then:

* `inspect`, before anything learns from the model: a fragment it says isn't in the photo goes, if it's
  a small loose piece in no RoomPlan box; a piece of furniture it says has holes or missing parts is
  made again by the furniture stage (furniture.py), a dresser or a TV stand too (not a kitchen's
  cabinets): what's a box in real life (a dresser, a cabinet, a nightstand) as the box RoomPlan
  measured, anything else by the shape maker. Which piece it means is what the model shows inside its
  box (the RoomPlan box most of those surface points lie in), so a box drawn tight around a hole still
  finds its dresser. The reviewer having seen the scan is broken, a pick replaces it without having to
  match the photos' outlines better than the scan does (holes don't show in an outline);
* `final`, once the remaster is done: what it still finds goes into the stats, for the dashboard.

It needs ANTHROPIC_API_KEY in the worker's environment (the atrium-photoreal secret); without it the
review is skipped and the rest runs as before.
"""

from __future__ import annotations

import base64
import io
import json
import os
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Protocol

import numpy as np
from PIL import Image

from atrium_photoreal.capture import Capture, load_photo
from atrium_photoreal.sharpness import smear_px

from .edit import apply
from .layout import Box, Layout
from .loose import measure, LooseConfig
from .scene import Mesh
from .views import Caster, render

MODEL = "claude-opus-5-5"
PRICE = (4.0, 20.0)  # its US dollars per million input and output tokens (thinking is output)
KINDS = ("fragment", "incomplete", "smear", "wrong_shape", "other")
FIXES = ("remove", "rebuild", "repaint", "none")
FURNITURE = ("sofa", "chair", "bed", "table", "storage", "none")
# What the reviewer calls a piece, and the RoomPlan categories that can be it (RoomPlan files some
# cabinets as tables and some armchairs as sofas): a cabinet's problem never lands on the sofa beside it.
MATCHES = {"sofa": ("sofa", "chair"), "chair": ("chair", "sofa"), "bed": ("bed",), "table": ("table", "storage"), "storage": ("storage", "table"), "none": ()}

SYSTEM = """You review 3D models of homes made from a phone scan, before they go on a real estate listing.

Each time you get two images taken from the same camera: first a photo of the real room, then the 3D model \
rendered from that viewpoint. The render is flat-shaded from the model's own textures; grey background means \
the model has nothing there.

List what's wrong with the model that a home buyer would notice:
- fragment: a piece of the model that isn't in the photo (bits floating in the air, shards on the floor, \
remains of a person who walked by). Fix: remove.
- incomplete: an object that's whole in the photo but has holes, missing sides or chunks in the model (a \
dresser with a hole in its top, a chair without legs, a sofa cut in half). A box-shaped piece of furniture (a \
dresser, a cabinet) whose sides are ragged, warped or blotched with patches of the wrong color is incomplete \
too: its shape is what's wrong, so the photos paint badly onto it. Fix: rebuild.
- smear: a blurry, smeared, stretched or wrongly colored patch on a wall, floor, painting or other flat surface \
that's sharp and clean in the photo (a grey smear across a painting). Fix: repaint.
- wrong_shape: an object whose shape is clearly wrong (a lumpy blob where the photo shows an armchair). Fix: \
rebuild.
- other: anything else clearly broken. Fix: none.

Don't report: differences in lighting, exposure or color cast; slight misalignment between the images; \
people or pets in the photo; parts of the render that are grey background; small imperfections a buyer \
wouldn't notice; anything you aren't fairly sure of. Report each problem once, with a tight box around it \
on the render (the second image) as [x0, y0, x1, y1] in thousandths of its width and height (for incomplete \
and wrong_shape, around the whole object, not just its hole), a point [x, y] on the object itself near its \
middle (in the same thousandths; on the object, not on a hole in it or on what's behind it), and say in a few \
words what the thing is ("wooden dresser", "painting over the dresser", "fragments on the floor"). Say \
whether the real thing is basically a box (boxy: a dresser, chest of drawers, cabinet, nightstand, TV stand, \
bookcase, desk, ottoman) or not (a sofa, armchair, bed, plant, lamp), and what kind of furniture it is as a \
floor plan app would file it (furniture: sofa, chair, bed, table, storage for dressers, chests, cabinets, \
shelves, nightstands and TV stands, or none for anything else: a lamp, a plant, a hamper, a rug, a wall). An \
empty list is a fine answer."""

SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "what": {"type": "string"},
                    "box": {"type": "array", "items": {"type": "integer"}},
                    "point": {"type": "array", "items": {"type": "integer"}},
                    "fix": {"type": "string", "enum": list(FIXES)},
                    "sure": {"type": "string", "enum": ["low", "medium", "high"]},
                    "boxy": {"type": "boolean"},
                    "furniture": {"type": "string", "enum": list(FURNITURE)},
                },
                "required": ["kind", "what", "box", "point", "fix", "sure", "boxy", "furniture"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["issues"],
    "additionalProperties": False,
}

# Furniture the furniture stage may make again when the reviewer asks (built-ins it never touches).
REBUILDABLE = ("sofa", "chair", "bed", "table", "storage")
# Those whose RoomPlan box is the piece itself when it's boxy (a dresser, a cabinet, a nightstand, a
# table that's a cube); never a sofa's (its box takes in the back cushions: a real chaise came out a
# block twice its height) or a bed's.
BOXES = ("storage", "table")
# A "storage" box this close to one of these is a kitchen's or a bathroom's cabinets: built in.
FIXTURES = ("sink", "stove", "oven", "dishwasher", "refrigerator", "washerDryer", "toilet", "bathtub")


@dataclass
class Issue:
    kind: str
    what: str
    box: tuple[float, float, float, float]  # on the render, 0-1 of its width and height
    fix: str
    sure: str
    boxy: bool = False
    furniture: str = ""  # one of FURNITURE, or "" (unsaid: any piece)
    point: tuple[float, float] | None = None  # on the object, 0-1 of the render's width and height
    view: int = -1
    outcome: str = ""  # what was done about it, for the dashboard
    piece: str = ""  # the RoomPlan id of the furniture it's sent to be made again


class Reviewer(Protocol):
    """A photo and the model rendered from its camera, (H, W, 3) uint8 each, in; what's wrong out."""

    name: str

    def __call__(self, photo: np.ndarray, rendered: np.ndarray) -> list[Issue]: ...


def jpeg_b64(image: np.ndarray, quality: int = 85) -> str:
    out = io.BytesIO()
    Image.fromarray(np.asarray(image, np.uint8)).save(out, "JPEG", quality=quality)
    return base64.standard_b64encode(out.getvalue()).decode("ascii")


def parse_issues(text: str) -> list[Issue]:
    """The reviewer's JSON answer as issues (malformed entries dropped)."""
    out = []
    for item in json.loads(text).get("issues", []):
        box = item.get("box") or []
        if len(box) != 4 or item.get("kind") not in KINDS or item.get("fix") not in FIXES:
            continue
        x0, y0, x1, y1 = (min(max(float(v), 0.0), 1000.0) / 1000 for v in box)
        if x1 <= x0 or y1 <= y0:
            continue
        furniture = item.get("furniture") if item.get("furniture") in FURNITURE else ""
        point = item.get("point") or []
        at = (min(max(float(point[0]), 0.0), 1000.0) / 1000, min(max(float(point[1]), 0.0), 1000.0) / 1000) if len(point) == 2 else None
        out.append(Issue(item["kind"], str(item.get("what", ""))[:80], (x0, y0, x1, y1), item["fix"], str(item.get("sure", "medium")), bool(item.get("boxy", False)), furniture, at))
    return out


class ClaudeReviewer:
    """Claude, through the Anthropic API (ANTHROPIC_API_KEY). A refusal is no issues; with server-side
    fallbacks a declined request is answered by Anthropic's recommended fallback model instead. It
    thinks at medium effort (high costs about twice as much, the thinking being most of a review's
    cost) and counts the tokens it used."""

    name = MODEL

    def __init__(self, client=None, model: str = MODEL, effort: str = "medium"):
        if client is None:
            import anthropic

            client = anthropic.Anthropic()
        self.client, self.model, self.effort = client, model, effort
        self.tokens = {"input": 0, "output": 0}
        self._lock = threading.Lock()

    def usage(self) -> dict:
        """Tokens used so far, and what they cost (US dollars, list price)."""
        cost = (self.tokens["input"] * PRICE[0] + self.tokens["output"] * PRICE[1]) / 1e6
        return {**self.tokens, "dollars": round(cost, 3)}

    def __call__(self, photo: np.ndarray, rendered: np.ndarray) -> list[Issue]:
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": SCHEMA}},
            system=SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "The photo:"},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(photo)}},
                        {"type": "text", "text": "The model from the same camera:"},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(rendered)}},
                        {"type": "text", "text": "What's wrong with the model? Boxes on the second image."},
                    ],
                }
            ],
        )
        used = getattr(response, "usage", None)
        if used is not None:
            with self._lock:
                self.tokens["input"] += int(getattr(used, "input_tokens", 0) or 0)
                self.tokens["output"] += int(getattr(used, "output_tokens", 0) or 0)
        if response.stop_reason in ("refusal", "max_tokens"):
            return []
        text = next((b.text for b in response.content if b.type == "text"), "")
        return parse_issues(text) if text else []


def reviewer_from_env(log=print) -> Reviewer | None:
    """Claude if the worker has a key for it, else None (the review is skipped)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        log("review: no ANTHROPIC_API_KEY; skipped")
        return None
    try:
        return ClaudeReviewer()
    except Exception:
        traceback.print_exc()
        return None


@dataclass(frozen=True)
class ReviewConfig:
    views: int = 10  # photos reviewed: between them showing every piece of furniture, then spread along the walk
    survey_px: int = 160  # each photo is checked for the furniture it shows at this size
    survey_share: float = 0.01  # ... a piece filling this much of it counting as shown
    long_side: int = 1024  # each image at this size
    max_smear: float = 2.0  # pixels (at the review size): blurrier photos aren't shown
    remove_area: float = 1.0  # m²: the most a piece the reviewer removes may have
    remove_share: float = 0.4  # ... and this much of it, as the render shows it, inside the reviewer's box
    point_reach: float = 0.02  # of the long side: what the model shows this close to the reviewer's point is what it points at
    rebuild_share: float = 0.3  # a RoomPlan box rebuilt: this much of what the reviewer's box shows lies in it,
    rebuild_taken: float = 0.5  # ... or this much of what the view shows of the piece is in the reviewer's box
    rebuild_least: float = 0.08  # ... and it's at least this much of the box (a loose box)
    box_margin: float = 0.05  # m: a surface point this close to a RoomPlan box is in it
    fixture_reach: float = 1.0  # m: storage this close to a fixture is built in
    workers: int = 8


@dataclass
class View:
    index: int
    photo: np.ndarray
    rendered: np.ndarray
    piece: np.ndarray  # (H, W) the loose-piece id each pixel shows, -1 for none
    K: np.ndarray
    camtoworld: np.ndarray
    box_of: np.ndarray | None = None  # (H, W) the index of the RoomPlan box (of those asked) each pixel shows, -1 for none


def furniture_shown(mesh: Mesh, cameras: list, boxes: list[Box], cfg: ReviewConfig) -> list[dict[int, int]]:
    """For each photo, the boxes it shows (their index: the pixels showing them, at the survey size)."""
    caster = Caster.of(mesh)
    out = []
    for cam in cameras:
        scale = cfg.survey_px / max(cam.width, cam.height)
        w, h = max(8, round(cam.width * scale)), max(8, round(cam.height * scale))
        K = np.asarray(cam.K, np.float64).copy()
        K[0] *= w / cam.width
        K[1] *= h / cam.height
        ids = box_map(mesh, caster.view(K, cam.camtoworld, w, h), boxes, cfg.box_margin)
        counts = np.bincount(ids[ids >= 0], minlength=len(boxes))
        out.append({i: int(c) for i, c in enumerate(counts) if c >= cfg.survey_share * w * h})
    return out


def pick_cameras(capture: Capture, cfg: ReviewConfig, mesh: Mesh | None = None, boxes: list[Box] | None = None) -> list:
    """Up to `views` sharp photos, in the order they were taken. First, one at a time, the photo
    showing the most furniture no photo picked so far shows (the most of it, on a tie), so every
    piece the reviewer could have made again is looked at; then the rest evenly along the walk (so
    every room gets some). Evenly alone, a few photos can miss a piece altogether."""
    sharp = [c for c in capture.cameras if (smear_px(c, cfg.long_side / max(c.width, c.height)) or 0.0) <= cfg.max_smear] or list(capture.cameras)
    if len(sharp) <= cfg.views:
        return sharp
    picked: set[int] = set()
    if mesh is not None and boxes:
        shows = furniture_shown(mesh, sharp, boxes, cfg)
        left = set().union(*shows)
        while left and len(picked) < cfg.views:
            best = max(range(len(sharp)), key=lambda i: (len(shows[i].keys() & left), sum(shows[i][b] for b in shows[i].keys() & left)))
            if not shows[best].keys() & left:
                break
            picked.add(best)
            left -= shows[best].keys()
    rest = [i for i in range(len(sharp)) if i not in picked]
    if len(picked) < cfg.views and rest:
        picked |= {rest[int(j)] for j in np.linspace(0, len(rest) - 1, cfg.views - len(picked)).round()}
    return [sharp[i] for i in sorted(picked)]


def box_map(mesh: Mesh, hits, boxes: list[Box], margin: float) -> np.ndarray:
    """(H, W) the index of the box each pixel's surface point lies in (the smallest, where boxes
    overlap: a nightstand against a bed), -1 for none."""
    out = np.full(hits.shape, -1, np.int64)
    if not boxes:
        return out
    hit = hits.hit
    corners = mesh.vertices[mesh.faces[hits.face[hit]]].astype(np.float64)
    b = hits.bary[hit].astype(np.float64)
    points = corners[:, 0] * (1 - b[:, :1] - b[:, 1:]) + corners[:, 1] * b[:, :1] + corners[:, 2] * b[:, 1:]
    flat = np.full(len(points), -1, np.int64)
    for i in sorted(range(len(boxes)), key=lambda i: -float(np.prod(boxes[i].size))):
        flat[boxes[i].contains(points, margin)] = i
    out[hit] = flat
    return out


def make_views(
    mesh: Mesh, capture: Capture, cfg: ReviewConfig, of_face: np.ndarray | None = None, boxes: list[Box] | None = None, cameras: list | None = None
) -> list[View]:
    """The picked photos (or `cameras`) and the model rendered from each."""
    caster = Caster.of(mesh)
    out = []
    for i, cam in enumerate(cameras if cameras is not None else pick_cameras(capture, cfg, mesh, boxes)):
        photo, K, _ = load_photo(cam, cfg.long_side)
        h, w = photo.shape[:2]
        hits = caster.view(K, cam.camtoworld, w, h)
        rendered = (np.clip(render(mesh, hits, background=(0.5, 0.5, 0.5)), 0, 1) * 255 + 0.5).astype(np.uint8)
        piece = np.full((h, w), -1, np.int64)
        if of_face is not None:
            piece[hits.hit] = of_face[hits.face[hits.hit]]
        box_of = box_map(mesh, hits, boxes, cfg.box_margin) if boxes is not None else None
        out.append(View(i, np.asarray(photo, np.uint8), rendered, piece, K, cam.camtoworld, box_of))
    return out


def ask(reviewer: Reviewer, views: list[View], cfg: ReviewConfig, log=print) -> list[Issue]:
    """Every view's issues (a view the reviewer fails on has none)."""

    def one(v: View) -> list[Issue]:
        try:
            issues = reviewer(v.photo, v.rendered)
        except Exception as e:
            log(f"review: view {v.index}: {type(e).__name__}: {e}"[:200])
            return []
        for issue in issues:
            issue.view = v.index
        return issues

    with ThreadPoolExecutor(max_workers=max(1, cfg.workers)) as pool:
        return [issue for found in pool.map(one, views) for issue in found]


def pixel_box(issue: Issue, shape: tuple[int, int]) -> tuple[slice, slice]:
    h, w = shape
    x0, y0, x1, y1 = issue.box
    return slice(int(y0 * h), max(int(y0 * h) + 1, int(np.ceil(y1 * h)))), slice(int(x0 * w), max(int(x0 * w) + 1, int(np.ceil(x1 * w))))


def projected_box(box: Box, view: View) -> tuple[float, float, float, float] | None:
    """A RoomPlan box's outline on a view (0-1 of its width and height), or None if it's behind the camera."""
    h, w = view.piece.shape
    local = (box.corners() - view.camtoworld[:3, 3]) @ view.camtoworld[:3, :3]
    if (local[:, 2] <= 0.05).any():
        return None
    u = view.K[0, 0] * local[:, 0] / local[:, 2] + view.K[0, 2]
    v = view.K[1, 1] * local[:, 1] / local[:, 2] + view.K[1, 2]
    x0, x1 = np.clip([u.min() / w, u.max() / w], 0, 1)
    y0, y1 = np.clip([v.min() / h, v.max() / h], 0, 1)
    return (float(x0), float(y0), float(x1), float(y1)) if x1 > x0 and y1 > y0 else None


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def pointed_at(issue: Issue, view: View, boxes: list[Box], cfg: ReviewConfig) -> tuple[Box | None, str]:
    """The RoomPlan box the reviewer means, of the kind it names, and how it was found: the one the
    model shows around its point on the object; failing that, the one most of its box shows, or most
    of which its box takes in (a loose box); failing that (the piece barely in the model at all), the
    one whose outline best matches its box. None, with what came nearest, if none does."""
    allowed = MATCHES.get(issue.furniture)
    fits = np.array([allowed is None or box.category in allowed for box in boxes], bool)
    if not fits.any():
        return None, "no RoomPlan piece of that kind"
    nearest = "nothing RoomPlan measured in its box"
    if view.box_of is not None:
        h, w = view.box_of.shape
        n = len(boxes)
        if issue.point is not None:
            r = max(2, round(cfg.point_reach * max(w, h)))
            px, py = int(issue.point[0] * w), int(issue.point[1] * h)
            near = view.box_of[max(0, py - r) : py + r + 1, max(0, px - r) : px + r + 1]
            counts = np.where(fits, np.bincount(near[near >= 0], minlength=n), 0)
            if counts.max() > 0:
                return boxes[int(counts.argmax())], "its point"
        ys, xs = pixel_box(issue, (h, w))
        inside = view.box_of[ys, xs]
        there = np.where(fits, np.bincount(inside[inside >= 0], minlength=n), 0)
        share = there / max(inside.size, 1)
        taken = there / np.maximum(np.bincount(view.box_of[view.box_of >= 0], minlength=n), 1)
        ok = (share >= cfg.rebuild_share) | ((taken >= cfg.rebuild_taken) & (share >= cfg.rebuild_least))
        if ok.any():
            return boxes[int(np.argmax(np.where(ok, share + taken, -1.0)))], "its box"
        if there.any():
            i = int(np.argmax(share + taken))
            nearest = f"nearest the {boxes[i].category} {boxes[i].id[:8]}: {share[i]:.2f} of its box, {taken[i]:.2f} of the piece"
    best, best_iou = None, cfg.rebuild_share
    for box, ok in zip(boxes, fits):
        if not ok:
            continue
        outline = projected_box(box, view)
        score = iou(outline, issue.box) if outline is not None else 0.0
        if score >= best_iou:
            best, best_iou = box, score
    return (best, "its outline") if best is not None else (None, nearest)


def built_in(box: Box, layout: Layout, reach: float) -> bool:
    if box.category != "storage":
        return False
    return any(np.linalg.norm(o.center - box.center) - (o.size.max() + box.size.max()) / 2 < reach for o in layout.objects if o.category in FIXTURES)


def rebuildable(layout: Layout, cfg: ReviewConfig) -> list[Box]:
    """The furniture the reviewer may have made again."""
    return [b for b in layout.objects if b.category in REBUILDABLE and not built_in(b, layout, cfg.fixture_reach)]


@dataclass
class Verdict:
    issues: list[Issue] = field(default_factory=list)
    removed: int = 0
    removed_area: float = 0.0
    rebuild: dict[str, str] = field(default_factory=dict)  # RoomPlan id: "box" or "made"
    cameras: list = field(default_factory=list)  # the photos it was shown (`final` shows the same: no more go to it)


def inspect(mesh: Mesh, capture: Capture, layout: Layout, reviewer: Reviewer, cfg: ReviewConfig = ReviewConfig(), log=print) -> tuple[Mesh, Verdict]:
    """The scan as sent, reviewed: fragments the reviewer is sure of go, and the furniture it finds with
    holes or the wrong shape is listed to be made again (Verdict.rebuild: RoomPlan id to "box" for what's
    a box in real life, "made" for the shape maker)."""
    found = measure(mesh, LooseConfig())
    in_box = np.array([any(bool(b.contains(m[None], 0.1)[0]) for b in layout.objects) for m in found.middle], bool)
    removable = (found.area <= cfg.remove_area) & ~in_box
    pieces = rebuildable(layout, cfg)
    cameras = pick_cameras(capture, cfg, mesh, pieces)
    views = make_views(mesh, capture, cfg, found.of_face, pieces, cameras)
    verdict = Verdict(ask(reviewer, views, cfg, log), cameras=cameras)
    by_view = {v.index: v for v in views}
    remove = np.zeros(len(found.area), bool)
    for issue in verdict.issues:
        view = by_view.get(issue.view)
        if view is None or issue.sure == "low":
            issue.outcome = "not sure enough to act on" if view is not None else ""
            continue
        if issue.fix == "remove":
            ys, xs = pixel_box(issue, view.piece.shape)
            inside = view.piece[ys, xs]
            seen = np.bincount(view.piece[view.piece >= 0], minlength=len(found.area))
            there = np.bincount(inside[inside >= 0], minlength=len(found.area))
            share = np.where(seen > 0, there / np.maximum(seen, 1), 0.0)
            these = removable & (share >= cfg.remove_share) & (there > 0)
            remove |= these
            issue.outcome = "removed" if these.any() else "left: not a small loose piece"
        elif issue.fix == "rebuild":
            if issue.furniture == "none":
                issue.outcome = "left: not furniture RoomPlan measures"
                continue
            box, how = pointed_at(issue, view, pieces, cfg)
            if box is None:
                log(f"review: view {issue.view}: {issue.what!r} ({issue.furniture or 'any'}) matched no piece: {how}"[:240])
                issue.outcome = "left: no furniture piece RoomPlan measured there"
                continue
            log(f"review: view {issue.view}: {issue.what!r} is the {box.category} {box.id[:8]} (by {how})"[:240])
            # Boxy in any view, a box (the photos paint its drawers on it).
            boxed = issue.boxy and box.category in BOXES
            if verdict.rebuild.get(box.id) != "box":
                verdict.rebuild[box.id] = "box" if boxed else "made"
            issue.piece = box.id
            issue.outcome = "to be rebuilt as a box" if boxed else "to be made again by the shape AI"
        elif issue.fix == "repaint":
            issue.outcome = "left: repainting isn't built yet"
    verdict.removed = int(remove.sum())
    verdict.removed_area = round(float(found.area[remove].sum()), 3)
    if remove.any():
        mesh, _ = apply(mesh, remove[found.of_face], [])
    log(f"review: {len(verdict.issues)} issues in {len(views)} views; {verdict.removed} fragments removed, {len(verdict.rebuild)} pieces to make again")
    return mesh, verdict


def rebuilt(verdict: Verdict, made: list[str]) -> None:
    """Once the furniture stage has run: each pick's problem says whether its piece was replaced."""
    for issue in verdict.issues:
        if issue.piece:
            box = verdict.rebuild.get(issue.piece) == "box"
            issue.outcome = ("rebuilt as a box" if box else "made again") if issue.piece in made else "tried, but the scan stayed"


def final(
    mesh: Mesh, capture: Capture, reviewer: Reviewer, cfg: ReviewConfig = ReviewConfig(), log=print, layout: Layout | None = None, cameras: list | None = None
) -> list[Issue]:
    """What the reviewer still finds in the finished model, from `cameras` (those `inspect` showed it,
    so no more photos go to it) or photos picked as `inspect` picks them."""
    views = make_views(mesh, capture, cfg, boxes=rebuildable(layout, cfg) if layout is not None else None, cameras=cameras or None)
    issues = [i for i in ask(reviewer, views, cfg, log) if i.sure != "low"]
    log(f"review: {len(issues)} issues left in the finished model")
    return issues


def selftest(reviewer: Reviewer) -> dict:
    """One review of a made-up room, to check the reviewer reaches its model (a few cents): a photo of
    a wall and a dresser, and a "model" with a dark fragment in the air and a hole in the dresser's
    front. Never shows the key; an error says only what kind it was."""
    photo = np.empty((384, 512, 3), np.uint8)
    photo[:] = (228, 220, 202)  # wall
    photo[260:] = (150, 112, 76)  # wooden floor
    photo[170:290, 160:360] = (112, 74, 46)  # dresser
    photo[200:205, 175:345] = photo[240:245, 175:345] = (80, 52, 32)  # its drawers
    rendered = photo.copy()
    rendered[60:110, 60:100] = (40, 40, 44)  # a fragment in the air
    rendered[190:240, 230:300] = (228, 220, 202)  # a hole in the dresser
    try:
        issues = reviewer(photo, rendered)
    except Exception as e:
        return {"ok": False, "why": f"{type(e).__name__}: {e}"[:300]}
    out = {"ok": True, "issues": summary(issues), "fixes": sorted({i.fix for i in issues}), "boxy": any(i.boxy for i in issues)}
    if hasattr(reviewer, "usage"):
        out["tokens"] = reviewer.usage()
    return out


def summary(issues: list[Issue], limit: int = 25) -> list[str]:
    """Short lines for the dashboard, each problem once, what was acted on and the surest first."""
    rank = {"rebuild": 0, "remove": 1, "repaint": 2, "none": 3}
    sure = {"high": 0, "medium": 1, "low": 2}
    out: list[str] = []
    for issue in sorted(issues, key=lambda i: (rank.get(i.fix, 4), sure.get(i.sure, 3))):
        line = f"{issue.kind.replace('_', ' ')}: {issue.what}"[:90] + (f" ({issue.outcome})" if issue.outcome else "")
        if line not in out:
            out.append(line)
    return out[:limit]


ReviewerFactory = Callable[[], Reviewer | None]
