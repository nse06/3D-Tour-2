"""The cleanup AI's views feed the skins (docs/remaster.md §4.2).

Where buyers walk between the spots the photos were taken from, the skins show what the photos told
them, at an angle and a distance no photo had: soft, seamy, smudged where nothing was seen. NVIDIA's
Fixer (the photoreal AI version's cleanup model, atrium_photoreal/enhance.py) cleans up renders of
the skins from there; the skins then also learn from the cleaned views, at a lower weight than the
photos, with the render's broad shading put back (the tone lock: the Fixer has its own idea of a
wall's tone). It goes in rounds as the skins take shape, each round's views a little further from the
photos (Difix3D+'s progressive distillation), so each clean-up has little to fix.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from atrium_photoreal.capture import Capture
from atrium_photoreal.enhance import EnhanceConfig, Fixer, between, choose_views, intrinsics, lock_tone

from .scene import Mesh
from .skins import ExtraViews, SkinConfig, View, prepare_view, trained_size
from .views import Caster


@dataclass
class FixerViewsConfig:
    rounds: int = 2  # at `start` of the steps, then evenly to 85%
    start: float = 0.45
    views: int = 80
    width: int = 1024  # the Fixer's size
    height: int = 576
    fov: float = 75.0
    share: float = 0.25  # of the views each step draws
    weight: float = 0.5  # against a photo's
    tone_lock: float = 0.012  # the render's shading above this fraction of the width (enhance.lock_tone)
    seed: int = 3


def fixer_views(
    mesh: Mesh, capture: Capture, skin_cfg: SkinConfig, cfg: FixerViewsConfig, fixer: Fixer, device: str = "cpu", log=print, store: str | None = None
) -> ExtraViews:
    """The rounds of cleaned views for skins.train, kept on `store` (the training device by default)."""
    store = store or device
    enhance_cfg = EnhanceConfig(views=cfg.views, width=cfg.width, height=cfg.height, fov=cfg.fov, seed=cfg.seed)
    walks = choose_views(capture, enhance_cfg, np.random.default_rng(cfg.seed))
    K = intrinsics(enhance_cfg)
    caster = Caster.of(mesh)
    sizes = trained_size(mesh, skin_cfg)
    texel = mesh.texel_size()
    normals = mesh.face_normals
    if cfg.rounds <= 1:
        at = [cfg.start]
    else:
        at = [cfg.start + (0.85 - cfg.start) * k / (cfg.rounds - 1) for k in range(cfg.rounds)]

    def make(render, round_index: int) -> list[View]:
        t = (round_index + 1) / max(1, cfg.rounds)
        made: list[View] = []
        for k, walk in enumerate(walks):
            blank = np.zeros((cfg.height, cfg.width, 3), np.float32)
            view = prepare_view(mesh, caster, blank, K, between(walk, t), skin_cfg, sizes, texel, normals, None, f"walk{k:03d}", store)
            if not bool(view.valid.any()):
                continue
            made.append(view)
        if not made:
            return []
        renders = [render(v) for v in made]
        fixed = fixer([(np.clip(r, 0, 1) * 255 + 0.5).astype(np.uint8) for r in renders])
        sigma = cfg.tone_lock * cfg.width
        for view, rendered, clean in zip(made, renders, fixed):
            if clean.shape != rendered.shape:
                raise RuntimeError(f"the fixer answered {clean.shape} for {rendered.shape}")
            alpha = view.valid.float().cpu()[..., None]
            target = lock_tone(torch.from_numpy(rendered), torch.from_numpy(clean.astype(np.float32) / 255), alpha, sigma)
            view.image = (target.clamp(0, 1) * 255 + 0.5).to(torch.uint8).to(view.valid.device)
            view.learn_color = False
            view.weight = cfg.weight
        log(f"fixer views: round {round_index + 1}, {len(made)} views {t:.0%} of the way from the photos ({fixer.name})")
        return made

    return ExtraViews(at=at, share=cfg.share, make=make)
