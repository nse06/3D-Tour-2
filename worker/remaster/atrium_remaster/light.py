"""Better lighting (docs/remaster.md §4.8): one color adjustment for the whole home, applied the same way
to the model's skins and to the photo spots, so the two still agree where the viewer blends them.

Homes are scanned under whatever light they had: warm bulbs, a grey afternoon, a dim back bedroom.
Painted walls are close to neutral and are the bulk of every home, so they show what the light did:

* white balance: the tint of the brighter wall texels of the walls' typical color (feature walls and art
  differ from it and are left out) is mostly taken out;
* exposure: the walls' median brightness is raised toward a bright daylight level (and only darkened
  a little, when a scan came out too bright);
* tone: shadows open up a little, and a soft shoulder rolls highlights off instead of clipping them,
  so windows and lamps keep their detail, with white landing on white;
* near white (a blown-out window, a lamp: the camera's white, not the room's light) the white balance
  eases off, so windows stay white rather than taking on the walls' correction (a real home's windows
  came out a pinkish grey).

Per pixel only, nothing spatial: every surface keeps its own texture and shading, and a pixel gets the
same answer in the skins and in a photo spot. Nothing is added or removed (site: /legal/ai).
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field

import numpy as np

from .scene import Mesh

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def linear_of_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4)).astype(np.float32)


def srgb_of_linear(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055).astype(np.float32)


@dataclass(frozen=True)
class LightConfig:
    white_balance: float = 0.85  # share of the walls' tint taken out
    max_tint: float = 0.4  # the most any channel's gain moves either way
    wall_target: float = 0.8  # sRGB brightness the walls' median is brought toward
    max_gain: float = 1.8  # brightening at most this much
    min_gain: float = 0.9  # darkening at most this much
    lift: float = 0.12  # shadow lift: luminance is raised to the power (1 - lift)
    shoulder: float = 0.8  # linear luminance above which highlights roll off toward white
    white_from: float = 0.9  # sRGB: colors with every channel above this lose the white balance by white
    samples: int = 200_000  # wall texels sampled to measure the light
    max_chroma_distance: float = 0.05  # wall samples whose tint is further than this from the walls' typical tint (accent walls, art) aren't used
    min_samples: int = 500  # fewer neutral wall samples than this: the light is left as it is


@dataclass(frozen=True)
class Light:
    """The adjustment, as a function of sRGB colors (any shape ending in 3, values 0-1)."""

    gains: np.ndarray = field(default_factory=lambda: np.ones(3, np.float32))  # linear, per channel
    lift: float = 0.0
    shoulder: float = 1.0
    white_from: float = 0.9

    @property
    def identity(self) -> bool:
        return bool(np.allclose(self.gains, 1)) and self.lift == 0 and self.shoulder >= 1

    def __call__(self, srgb: np.ndarray) -> np.ndarray:
        if self.identity:
            return srgb
        srgb = np.asarray(srgb, np.float32)
        exposure = float(self.gains @ LUMA)
        # Near white, exposure only: what the camera clipped has no color of the light's to take out.
        k = np.clip((srgb.min(axis=-1, keepdims=True) - self.white_from) / max(1 - self.white_from, 1e-6), 0, 1)
        k = k * k * (3 - 2 * k)
        lin = linear_of_srgb(srgb) * (self.gains + (exposure - self.gains) * k)
        y = np.maximum(lin @ LUMA, 1e-6)[..., None]
        y2 = np.power(y, 1 - self.lift)
        # Above the shoulder highlights roll off to land white on white: as steep as below where they
        # start, flattening out toward white (or, where the exposure darkens, rising a little faster).
        s, top = self.shoulder, exposure ** (1 - self.lift)  # top: where white is before the shoulder
        if s < 1 and top > s:
            t = np.clip((y2 - s) / (top - s), 0, 1)
            p = (top - s) / (1 - s)
            h = 1 - np.power(1 - t, p) if p >= 1 else p * t + (1 - p) * t * t
            y2 = np.where(y2 > s, s + (1 - s) * h, y2)
        out = lin * (y2 / y)
        # A channel over 1 would clip and shift the hue: move toward gray at the same luminance instead.
        peak = out.max(axis=-1, keepdims=True)
        mix = np.clip((peak - 1) / np.maximum(peak - y2, 1e-6), 0, 1)
        out = out + (y2 - out) * mix
        return srgb_of_linear(out)

    def stats(self) -> dict:
        return {"lightGains": [round(float(g), 3) for g in self.gains], "lightLift": round(self.lift, 3), "lightShoulder": round(self.shoulder, 3)}


def wall_samples(mesh: Mesh, n: int, rng: np.random.Generator) -> np.ndarray:
    """(N, 3) sRGB colors of points on the model's walls (textured triangles facing sideways),
    sampled by area."""
    textured = np.flatnonzero(mesh.face_atlas >= 0)
    if not len(textured):
        return np.zeros((0, 3), np.float32)
    normals = mesh.face_normals[textured]
    walls = textured[np.abs(normals[:, 1]) < 0.25]
    if not len(walls):
        return np.zeros((0, 3), np.float32)
    areas = mesh.face_areas[walls]
    if areas.sum() <= 0:
        return np.zeros((0, 3), np.float32)
    pick = rng.choice(walls, size=n, p=areas / areas.sum())
    r1, r2 = np.sqrt(rng.random(n)), rng.random(n)
    bary = np.stack([1 - r1, r1 * (1 - r2), r1 * r2], axis=1)
    uv = (mesh.uvs[mesh.faces[pick]] * bary[:, :, None]).sum(axis=1)
    out = np.zeros((n, 3), np.float32)
    for a, atlas in enumerate(mesh.atlases):
        sel = mesh.face_atlas[pick] == a
        if not sel.any():
            continue
        h, w = atlas.shape[:2]
        x = np.clip((uv[sel, 0] * w).astype(np.int64), 0, w - 1)
        y = np.clip((uv[sel, 1] * h).astype(np.int64), 0, h - 1)
        out[sel] = atlas[y, x]
    return out


def measure(mesh: Mesh, cfg: LightConfig = LightConfig(), seed: int = 0) -> tuple[Light, dict]:
    """The adjustment that brings this home's walls to neutral daylight, and what was measured."""
    samples = linear_of_srgb(wall_samples(mesh, cfg.samples, np.random.default_rng(seed)))
    if len(samples):
        y = samples @ LUMA
        lit = (y > 0.01) & (samples.max(axis=1) < 0.99)  # not black, not blown out
        chroma = samples / np.maximum(samples.sum(axis=1, keepdims=True), 1e-6)
        typical = np.median(chroma[lit], axis=0) if lit.any() else np.full(3, 1 / 3)
        neutral = samples[lit & (np.linalg.norm(chroma - typical, axis=1) < cfg.max_chroma_distance)]
    else:
        neutral = samples
    stats: dict = {"lightWallSamples": int(len(neutral))}
    if len(neutral) < cfg.min_samples:
        stats["lightSkipped"] = "too few plain wall texels"
        return Light(), stats
    ny = neutral @ LUMA
    bright = neutral[ny >= np.median(ny)]  # the lit half: the light's color, not the shadows'
    tint = bright.mean(axis=0) / max(float(bright.mean(axis=0) @ LUMA), 1e-6)
    wb = 1 + cfg.white_balance * (1 / np.maximum(tint, 1e-6) - 1)
    wb = np.clip(wb, 1 - cfg.max_tint, 1 + cfg.max_tint)
    wb = wb / float(wb @ LUMA)  # white balance keeps brightness; exposure is separate
    target = float(linear_of_srgb(np.array([cfg.wall_target]))[0])
    median = float(np.median((neutral * wb) @ LUMA))
    exposure = float(np.clip(target / max(median, 1e-6), cfg.min_gain, cfg.max_gain))
    light = Light(gains=(wb * exposure).astype(np.float32), lift=cfg.lift, shoulder=cfg.shoulder, white_from=cfg.white_from)
    stats.update(light.stats())
    stats["lightWallBefore"] = round(float(srgb_of_linear(np.array([median]))[0]), 3)
    stats["lightExposure"] = round(exposure, 3)
    return light, stats


def apply(mesh: Mesh, light: Light, rows: int = 512) -> Mesh:
    """The mesh with its skins and flat colors adjusted (a new mesh; atlases in row bands, they're big)."""
    if light.identity:
        return mesh
    atlases = []
    for atlas in mesh.atlases:
        out = np.empty_like(atlas)
        for r in range(0, atlas.shape[0], rows):
            out[r : r + rows] = light(atlas[r : r + rows])
        atlases.append(out)
    return dataclasses.replace(mesh, atlases=atlases, face_color=light(mesh.face_color).astype(np.float32))
