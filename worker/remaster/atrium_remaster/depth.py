"""Sharper depth from AI, so photos don't paint across the model's shapes (docs/remaster.md §4.3).

The model's shapes are RoomPlan's boxes and the LiDAR's mesh welded on a 2.5 cm grid and smoothed:
right in the large, a little off at edges, and missing what the scanner didn't keep (a plant, a lamp,
a chair's legs). Where a photo shows something in front of the model's surface, or the model has a
surface where the photo sees past it, the photo's color there belongs to something else, and the
skins would paint it on the wrong surface (a plant's leaves on the wall, the wall's color on a
sofa's edge).

A depth model trained to sharpen iPhone LiDAR — Prompt Depth Anything (Apache-2.0), which takes a
photo and coarse metric depth at ARKit's 192 × 256 and returns sharp metric depth — is prompted with
the model's own depth at the photo (ray cast at that size). Where its depth and the model's disagree
by more than `agree_abs` + `agree_rel` of the distance, the photo's pixels say nothing to the skins.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np
from PIL import Image
from scipy import ndimage

from atrium_photoreal.capture import Capture, load_photo

from .scene import Mesh
from .views import Caster


class DepthModel(Protocol):
    """Photos (H, W, 3) uint8 and their coarse metric depth (h, w) float32 meters in; sharp metric
    depth at each photo's size out."""

    name: str

    def __call__(self, images: list[np.ndarray], prompts: list[np.ndarray]) -> list[np.ndarray]: ...


@dataclass
class DepthConfig:
    prompt_size: tuple[int, int] = (256, 192)  # ARKit's LiDAR depth, landscape (width, height)
    long_side: int = 960  # the depth model sees the photos at this size
    agree_abs: float = 0.04
    agree_rel: float = 0.04
    grow_px: float = 2.0  # at `long_side`


class PromptAsDepth:
    """A stand-in for the depth model (tests): the prompt itself, scaled up (it always agrees)."""

    name = "prompt"

    def __call__(self, images: list[np.ndarray], prompts: list[np.ndarray]) -> list[np.ndarray]:
        return [np.array(Image.fromarray(p.astype(np.float32)).resize((im.shape[1], im.shape[0]), Image.BILINEAR)) for im, p in zip(images, prompts)]


def model_depth(caster: Caster, K: np.ndarray, camtoworld: np.ndarray, width: int, height: int, size: tuple[int, int]) -> np.ndarray:
    """The model's depth at a photo, at `size` (width, height): what the phone's LiDAR would say."""
    w, h = size
    k = K.copy()
    k[0] *= w / width
    k[1] *= h / height
    d = caster.view(k, camtoworld, w, h).depth
    # Nothing hit (a window to nowhere): the farthest the scene goes, as LiDAR reports far range.
    finite = np.isfinite(d)
    return np.where(finite, d, d[finite].max() if finite.any() else 5.0).astype(np.float32)


def disagreement(predicted: np.ndarray, modeled: np.ndarray, cfg: DepthConfig) -> np.ndarray:
    """(H, W) bool: where the depth model and the model's shape disagree (grown by `grow_px`)."""
    with np.errstate(invalid="ignore"):
        off = np.abs(predicted - modeled) > cfg.agree_abs + cfg.agree_rel * np.minimum(predicted, modeled)
    off &= np.isfinite(modeled)
    r = int(np.ceil(cfg.grow_px))
    if r > 0 and off.any():
        yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
        off = ndimage.binary_dilation(off, structure=(xx * xx + yy * yy) <= cfg.grow_px**2 + 1e-6)
    return off


def estimate(
    mesh: Mesh, capture: Capture, model: DepthModel, cfg: DepthConfig, batch: int = 8, log=print, progress=None
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Per photo (by camera name): the depth model's depth at `long_side`, prompted with the model's
    own depth there, and the photo's intrinsics at that size. `progress(share done)` after each batch."""
    caster = Caster.of(mesh)
    out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for k in range(0, len(capture.cameras), batch):
        group = capture.cameras[k : k + batch]
        images, prompts, Ks = [], [], []
        for cam in group:
            rgb, K, _ = load_photo(cam, cfg.long_side)
            images.append(rgb)
            prompts.append(model_depth(caster, cam.K, cam.camtoworld, cam.width, cam.height, cfg.prompt_size))
            Ks.append(K)
        for cam, image, pred, K in zip(group, images, model(images, prompts), Ks):
            if pred.shape != image.shape[:2]:
                raise RuntimeError(f"the depth model answered {pred.shape} for {image.shape[:2]}")
            out[cam.name] = (np.asarray(pred, np.float32), K)
        if progress is not None:
            progress((k + len(group)) / len(capture.cameras))
    log(f"depth: {len(out)} photos measured ({model.name})")
    return out


def compare(mesh: Mesh, capture: Capture, depths: dict[str, tuple[np.ndarray, np.ndarray]], cfg: DepthConfig, log=print) -> dict[str, np.ndarray]:
    """Per photo: where the depth model's depth disagrees with the model's shapes (as they are now)."""
    caster = Caster.of(mesh)
    out: dict[str, np.ndarray] = {}
    total = 0
    for cam in capture.cameras:
        if cam.name not in depths:
            continue
        pred, K = depths[cam.name]
        h, w = pred.shape
        mask = disagreement(pred, caster.view(K, cam.camtoworld, w, h).depth, cfg)
        out[cam.name] = mask
        total += int(mask.sum())
    share = total / max(1, sum(m.size for m in out.values()))
    log(f"depth: {share:.1%} of the photos' pixels disagree with the model's shapes")
    return out


def disagreements(mesh: Mesh, capture: Capture, model: DepthModel, cfg: DepthConfig, batch: int = 8, log=print) -> dict[str, np.ndarray]:
    """Per photo (by camera name): where its depth disagrees with the model's shape, at `long_side`."""
    return compare(mesh, capture, estimate(mesh, capture, model, cfg, batch, log), cfg, log)
