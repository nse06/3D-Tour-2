"""Photos cleaned up before the skins learn from them, and the skins tidied after (docs/remaster.md §4.1).

* **Sharper photos**: a photo the phone took while turning or walking is smeared (atrium_photoreal's
  sharpness: turn rate × exposure × focal length). Those smeared at least `min_smear_px` (at 1920 px)
  go through a deblurring model (NAFNet, models.py); the skins then count only what's left of the smear
  (`residual`). Sharp photos stay as they are: a deblurring model can only invent detail in them.
* **A TV that's off**: a TV that was on shows a different picture in every photo. Where the room layout
  (build 13) has a television, its screen says nothing to the skins, and comes out as a dark, slightly
  blue-gray glass.
* **Daylight in dark windows**: a scan made at night leaves the windows black. Where the layout has a
  window, the glass the photos left darker than `window_dark` is brightened to a soft daylight
  gradient; the frame, the mullions and anything in front (lighter than that) stay as photographed.
  The view isn't invented: the glass just isn't black.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from PIL import Image, ImageFilter

from atrium_photoreal.capture import Capture, load_photo
from atrium_photoreal.sharpness import smear_px

from .layout import Box, Layout, Opening
from .scene import Mesh


class Cleaner(Protocol):
    """Sharpens photos: (H, W, 3) uint8 images in, the same sizes out."""

    name: str

    def __call__(self, images: list[np.ndarray]) -> list[np.ndarray]: ...


@dataclass
class CleanupConfig:
    deblur: bool = True
    min_smear_px: float = 1.5  # at 1920 px across
    residual: float = 0.3  # the share of a sharpened photo's smear the skins still count
    tv_off: bool = True
    tv_color: tuple[float, float, float] = (0.055, 0.06, 0.07)  # sRGB
    windows: bool = True
    window_dark: float = 0.14  # luminance (sRGB 0-1) below which window glass counts as dark
    window_top: tuple[float, float, float] = (0.80, 0.86, 0.93)
    window_bottom: tuple[float, float, float] = (0.90, 0.91, 0.92)


class UnsharpCleaner:
    """A stand-in for the deblurring model (tests, runs without a GPU): an unsharp mask."""

    name = "unsharp-mask"

    def __call__(self, images: list[np.ndarray]) -> list[np.ndarray]:
        return [np.asarray(Image.fromarray(im).filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=2))) for im in images]


def sharpen_photos(capture: Capture, cleaner: Cleaner, cfg: CleanupConfig, long_side: int, batch: int = 8, log=print) -> dict[str, np.ndarray]:
    """The smeared photos, sharpened, at training size (by camera name); the others aren't in it."""
    out: dict[str, np.ndarray] = {}
    if not cfg.deblur:
        return out
    chosen = [c for c in capture.cameras if (smear_px(c, 1920 / max(c.width, c.height)) or 0.0) >= cfg.min_smear_px]
    for k in range(0, len(chosen), batch):
        group = chosen[k : k + batch]
        images = [load_photo(c, long_side)[0] for c in group]
        for cam, image, sharp in zip(group, images, cleaner(images)):
            if sharp.shape != image.shape:
                raise RuntimeError(f"the cleaner answered {sharp.shape} for {image.shape}")
            out[cam.name] = sharp
    log(f"cleanup: {len(out)} of {len(capture.cameras)} photos sharpened ({cleaner.name})")
    return out


def atlas_positions(mesh: Mesh, sizes: list[int] | None = None) -> list[tuple[np.ndarray, np.ndarray]]:
    """Per atlas (at `sizes`, default its own): where each texel center lies on the model, (S, S, 3)
    float32 (NaN for texels on no triangle), and on which triangle, (S, S) int64 (-1)."""
    sizes = sizes or [a.shape[0] for a in mesh.atlases]
    out = []
    for a, size in enumerate(sizes):
        pos = np.full((size, size, 3), np.nan, np.float32)
        face_of = np.full((size, size), -1, np.int64)
        faces = np.flatnonzero(mesh.face_atlas == a)
        uv = mesh.uvs[mesh.faces[faces]].astype(np.float64) * size  # (T, 3, 2) in texels
        xyz = mesh.vertices[mesh.faces[faces]].astype(np.float64)
        lo = np.floor(uv.min(1) - 0.5).astype(np.int64)
        hi = np.ceil(uv.max(1) + 0.5).astype(np.int64)
        for t in range(len(faces)):
            x0, y0 = max(lo[t, 0], 0), max(lo[t, 1], 0)
            x1, y1 = min(hi[t, 0], size), min(hi[t, 1], size)
            if x1 <= x0 or y1 <= y0:
                continue
            xx, yy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
            p0, p1, p2 = uv[t]
            d = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1])
            if abs(d) < 1e-12:
                continue
            l0 = ((p1[1] - p2[1]) * (xx - p2[0]) + (p2[0] - p1[0]) * (yy - p2[1])) / d
            l1 = ((p2[1] - p0[1]) * (xx - p2[0]) + (p0[0] - p2[0]) * (yy - p2[1])) / d
            l2 = 1 - l0 - l1
            inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
            if not inside.any():
                continue
            pts = l0[..., None] * xyz[t, 0] + l1[..., None] * xyz[t, 1] + l2[..., None] * xyz[t, 2]
            region = pos[y0:y1, x0:x1]
            region[inside] = pts[inside]
            face_of[y0:y1, x0:x1][inside] = faces[t]
        out.append((pos, face_of))
    return out


def screen_faces(mesh: Mesh, tvs: list[Box], margin: float = 0.04) -> np.ndarray:
    """(F,) bool: the triangles of a TV's screen (and its back): wholly inside the TV's box (a wall's
    big triangles reach past it), facing along its thinnest side."""
    out = np.zeros(len(mesh.faces), bool)
    if not tvs:
        return out
    corners = mesh.vertices[mesh.faces]  # (F, 3, 3)
    normals = mesh.face_normals
    for tv in tvs:
        thin = int(np.argmin(tv.size))
        inside = tv.contains(corners.reshape(-1, 3), margin).reshape(-1, 3).all(1)
        facing = np.abs(normals @ tv.axes[thin]) > math.cos(math.radians(25))
        out |= inside & facing & (mesh.face_atlas >= 0)
    return out


def window_mask(pos: np.ndarray, face_of: np.ndarray, normals: np.ndarray, window: Opening, depth: float = 0.2) -> np.ndarray:
    """(S, S) bool: the texels on the wall in a window's rectangle (facing along its normal)."""
    d = pos - window.center
    with np.errstate(invalid="ignore"):
        along = np.abs(d @ window.along) <= window.width / 2
        up = np.abs(d[..., 1]) <= window.height / 2
        near = np.abs(d @ window.normal) <= depth
    on_face = face_of >= 0
    facing = np.zeros_like(on_face)
    facing[on_face] = np.abs(normals[face_of[on_face]] @ window.normal) > math.cos(math.radians(20))
    return along & up & near & facing


def tidy_skins(mesh: Mesh, layout: Layout, cfg: CleanupConfig, log=print) -> tuple[Mesh, dict]:
    """The trained skins with the TVs off and dark windows brightened (needs the room layout)."""
    stats = {"tvsOff": 0, "windowsBrightened": 0}
    tvs = layout.objects_of("television") if cfg.tv_off else []
    windows = [o for o in layout.openings if o.kind == "window"] if cfg.windows else []
    if not tvs and not windows:
        return mesh, stats
    atlases = [a.copy() for a in mesh.atlases]
    positions = atlas_positions(mesh)
    normals = mesh.face_normals
    if tvs:
        screens = screen_faces(mesh, tvs)
        for a, (pos, face_of) in enumerate(positions):
            sel = (face_of >= 0) & screens[np.maximum(face_of, 0)]
            if sel.any():
                atlases[a][sel] = np.asarray(cfg.tv_color, np.float32)
        stats["tvsOff"] = len(tvs)
    for window in windows:
        changed = False
        for a, (pos, face_of) in enumerate(positions):
            mask = window_mask(pos, face_of, normals, window)
            if not mask.any():
                continue
            image = atlases[a]
            lum = image @ np.array([0.2126, 0.7152, 0.0722], np.float32)
            dark = mask & (lum < cfg.window_dark + 0.06)
            if not dark.any():
                continue
            # Glass much darker than the threshold becomes daylight; near it, a blend (no hard edge
            # at the frame).
            alpha = np.clip((cfg.window_dark + 0.06 - lum) / 0.12, 0, 1)[dark][:, None]
            t = np.clip((window.center[1] + window.height / 2 - pos[dark][:, 1]) / window.height, 0, 1)[:, None]
            day = (1 - t) * np.asarray(cfg.window_top, np.float32) + t * np.asarray(cfg.window_bottom, np.float32)
            image[dark] = (1 - alpha) * image[dark] + alpha * day
            changed = changed or bool((alpha > 0.5).any())
        stats["windowsBrightened"] += int(changed)
    log(f"cleanup: {stats['tvsOff']} TVs off, {stats['windowsBrightened']} windows brightened")
    return Mesh(mesh.vertices, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, atlases, mesh.extras), stats
