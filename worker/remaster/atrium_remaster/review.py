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
  measured, anything else by the shape maker; either is kept only if it then matches the photos better
  than the scan did;
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

SYSTEM = """You review 3D models of homes made from a phone scan, before they go on a real estate listing.

Each time you get two images taken from the same camera: first a photo of the real room, then the 3D model \
rendered from that viewpoint. The render is flat-shaded from the model's own textures; grey background means \
the model has nothing there.

List what's wrong with the model that a home buyer would notice:
- fragment: a piece of the model that isn't in the photo (bits floating in the air, shards on the floor, \
remains of a person who walked by). Fix: remove.
- incomplete: an object that's whole in the photo but has holes, missing sides or chunks in the model (a \
dresser with a hole in its top, a chair without legs, a sofa cut in half). Fix: rebuild.
- smear: a blurry, smeared, stretched or wrongly colored patch on a surface that's sharp and clean in the \
photo (a grey smear across a painting, a wall's color on a sofa). Fix: repaint.
- wrong_shape: an object whose shape is clearly wrong (a lumpy blob where the photo shows an armchair). Fix: \
rebuild.
- other: anything else clearly broken. Fix: none.

Don't report: differences in lighting, exposure or color cast; slight misalignment between the images; \
people or pets in the photo; parts of the render that are grey background; small imperfections a buyer \
wouldn't notice; anything you aren't fairly sure of. Report each problem once, with a tight box around it \
on the render (the second image) as [x0, y0, x1, y1] in thousandths of its width and height, and say in a \
few words what the thing is ("wooden dresser", "painting over the dresser", "fragments on the floor"). Say \
whether the real thing is basically a box (boxy: a dresser, chest of drawers, cabinet, nightstand, TV stand, \
bookcase, desk, ottoman) or not (a sofa, armchair, bed, plant, lamp). An empty list is a fine answer."""

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
                    "fix": {"type": "string", "enum": list(FIXES)},
                    "sure": {"type": "string", "enum": ["low", "medium", "high"]},
                    "boxy": {"type": "boolean"},
                },
                "required": ["kind", "what", "box", "fix", "sure", "boxy"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["issues"],
    "additionalProperties": False,
}

# Furniture the furniture stage may make again when the reviewer asks (built-ins it never touches).
REBUILDABLE = ("sofa", "chair", "bed", "table", "storage")
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
    view: int = -1


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
        out.append(Issue(item["kind"], str(item.get("what", ""))[:80], (x0, y0, x1, y1), item["fix"], str(item.get("sure", "medium")), bool(item.get("boxy", False))))
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
    views: int = 8  # photos reviewed, spread along the walk
    long_side: int = 1024  # each image at this size
    max_smear: float = 2.0  # pixels (at the review size): blurrier photos aren't shown
    remove_area: float = 1.0  # m²: the most a piece the reviewer removes may have
    remove_share: float = 0.4  # ... and this much of it, as the render shows it, inside the reviewer's box
    rebuild_share: float = 0.3  # a RoomPlan box rebuilt: its outline and the reviewer's box overlap this much (IoU)
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


def pick_cameras(capture: Capture, cfg: ReviewConfig) -> list:
    """Up to `views` sharp photos, evenly along the walk (so every room gets some)."""
    sharp = [c for c in capture.cameras if (smear_px(c, cfg.long_side / max(c.width, c.height)) or 0.0) <= cfg.max_smear] or list(capture.cameras)
    if len(sharp) <= cfg.views:
        return sharp
    return [sharp[int(i)] for i in np.linspace(0, len(sharp) - 1, cfg.views).round()]


def make_views(mesh: Mesh, capture: Capture, cfg: ReviewConfig, of_face: np.ndarray | None = None) -> list[View]:
    caster = Caster.of(mesh)
    out = []
    for i, cam in enumerate(pick_cameras(capture, cfg)):
        photo, K, _ = load_photo(cam, cfg.long_side)
        h, w = photo.shape[:2]
        hits = caster.view(K, cam.camtoworld, w, h)
        rendered = (np.clip(render(mesh, hits, background=(0.5, 0.5, 0.5)), 0, 1) * 255 + 0.5).astype(np.uint8)
        piece = np.full((h, w), -1, np.int64)
        if of_face is not None:
            piece[hits.hit] = of_face[hits.face[hits.hit]]
        out.append(View(i, np.asarray(photo, np.uint8), rendered, piece, K, cam.camtoworld))
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


def built_in(box: Box, layout: Layout, reach: float) -> bool:
    if box.category != "storage":
        return False
    return any(np.linalg.norm(o.center - box.center) - (o.size.max() + box.size.max()) / 2 < reach for o in layout.objects if o.category in FIXTURES)


@dataclass
class Verdict:
    issues: list[Issue] = field(default_factory=list)
    removed: int = 0
    removed_area: float = 0.0
    rebuild: dict[str, str] = field(default_factory=dict)  # RoomPlan id: "box" or "made"


def inspect(mesh: Mesh, capture: Capture, layout: Layout, reviewer: Reviewer, cfg: ReviewConfig = ReviewConfig(), log=print) -> tuple[Mesh, Verdict]:
    """The scan as sent, reviewed: fragments the reviewer is sure of go, and the furniture it finds with
    holes or the wrong shape is listed to be made again (Verdict.rebuild: RoomPlan id to "box" for what's
    a box in real life, "made" for the shape maker)."""
    found = measure(mesh, LooseConfig())
    in_box = np.array([any(bool(b.contains(m[None], 0.1)[0]) for b in layout.objects) for m in found.middle], bool)
    removable = (found.area <= cfg.remove_area) & ~in_box
    views = make_views(mesh, capture, cfg, found.of_face)
    verdict = Verdict(ask(reviewer, views, cfg, log))
    by_view = {v.index: v for v in views}
    remove = np.zeros(len(found.area), bool)
    for issue in verdict.issues:
        view = by_view.get(issue.view)
        if view is None or issue.sure == "low":
            continue
        if issue.fix == "remove":
            ys, xs = pixel_box(issue, view.piece.shape)
            inside = view.piece[ys, xs]
            seen = np.bincount(view.piece[view.piece >= 0], minlength=len(found.area))
            there = np.bincount(inside[inside >= 0], minlength=len(found.area))
            share = np.where(seen > 0, there / np.maximum(seen, 1), 0.0)
            remove |= removable & (share >= cfg.remove_share) & (there > 0)
        elif issue.fix == "rebuild":
            for box in layout.objects:
                if box.category not in REBUILDABLE or built_in(box, layout, cfg.fixture_reach):
                    continue
                outline = projected_box(box, view)
                if outline is not None and iou(outline, issue.box) >= cfg.rebuild_share and verdict.rebuild.get(box.id) != "box":
                    # Boxy in any view, a box (the photos paint its drawers on it).
                    verdict.rebuild[box.id] = "box" if issue.boxy else "made"
    verdict.removed = int(remove.sum())
    verdict.removed_area = round(float(found.area[remove].sum()), 3)
    if remove.any():
        mesh, _ = apply(mesh, remove[found.of_face], [])
    log(f"review: {len(verdict.issues)} issues in {len(views)} views; {verdict.removed} fragments removed, {len(verdict.rebuild)} pieces to make again")
    return mesh, verdict


def final(mesh: Mesh, capture: Capture, reviewer: Reviewer, cfg: ReviewConfig = ReviewConfig(), log=print) -> list[Issue]:
    """What the reviewer still finds in the finished model."""
    issues = [i for i in ask(reviewer, make_views(mesh, capture, cfg), cfg, log) if i.sure != "low"]
    log(f"review: {len(issues)} issues left in the finished model")
    return issues


def summary(issues: list[Issue], limit: int = 10) -> list[str]:
    """Short lines for the dashboard, each problem once."""
    out: list[str] = []
    for issue in issues:
        line = f"{issue.kind.replace('_', ' ')}: {issue.what}"[:90]
        if line not in out:
            out.append(line)
    return out[:limit]


ReviewerFactory = Callable[[], Reviewer | None]
