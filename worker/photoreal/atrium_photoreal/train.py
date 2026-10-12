"""Trains Gaussian splats on a capture: gsplat's 3DGS recipe (its simple_trainer, MCMC preset on a
GPU), adapted to phone scans of homes:

* splats start as flat discs on the painted model's surfaces (the seeds), in their painted colors;
* each photo gets an exposure and white-balance correction (a gain and an offset per color channel,
  averaging to none over the photos), so the phone's auto-exposure doesn't end up baked into the splats;
* each photo's pose is refined a little (the phone's tracking drifts);
* photos smeared by the phone moving are compared with the render smeared the same way, so they hold
  the shape without pulling the splats soft (sharpness.py);
* pixels showing people are left out;
* splats wandering far outside the rooms are dropped (window views may sit a few meters out);
* a random background behind the splats, so nothing stays see-through;
* the rooms' shape (shell.py): splats on a wall, floor or ceiling are kept flat on it, no splat is
  much longer than it is wide, and splats hanging in the air just in front of a camera are cleared,
  so the room holds together away from the spots the photos were taken from.

Given an AIVersion, training goes on after its steps for the AI-enhanced version (enhance.py): the
splats as they are then, the faithful version, go to `on_main` first.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import torch
import torch.nn.functional as F

from . import shell as room_shell
from .capture import Capture, load_photo, training_size
from .render import psnr, rasterize, rgb_to_sh, ssim
from .enhance import AIVersion, between, choose_views, intrinsics
from .sharpness import find_direction, line_kernel, photo_weights, smear_image


@dataclass
class TrainConfig:
    steps: int = 30_000
    # The phone's photos are 1920 px across: trained at full size, the splats keep their detail.
    long_side: int = 1920
    max_gaussians: int = 1_000_000
    sh_degree: int = 3
    sh_degree_interval: int = 1000
    ssim_lambda: float = 0.2
    means_lr: float = 1.6e-4
    scales_lr: float = 5e-3
    quats_lr: float = 1e-3
    opacities_lr: float = 5e-2
    sh0_lr: float = 2.5e-3
    shN_lr: float = 2.5e-3 / 20
    # MCMC's regularizers (gsplat's "mcmc" preset).
    opacity_reg: float = 0.01
    scale_reg: float = 0.01
    init_opacity: float = 0.5
    pose_lr: float = 1e-5
    pose_reg: float = 1e-6
    exposure_lr: float = 1e-3
    exposure_reg: float = 1e-2
    # "gain": a gain and an offset per color channel and photo, their average over the photos held at
    # none. "matrix": the first worker's 3x3 color matrix and offset per photo, kept for comparison: with
    # nothing holding their average, color drifts between the splats and the photos' corrections (one
    # channel can end up carrying all of it), which fits the photos and looks wrong in the viewer.
    exposure_model: str = "gain"
    # gsplat tunes MCMC for scenes scaled so that the cameras sit about one unit from their center. Its
    # position noise grows with the square of the unit and its scale penalty with the unit, so both are
    # sized to the capture as if it were scaled that way (False: as if the unit were the meter; a
    # whole apartment then gets about ten times the noise of a bedroom and doesn't converge).
    normalize: bool = True
    bounds_margin: float = 5.0
    refine_start: int = 500
    refine_stop_frac: float = 25 / 30
    refine_every: int = 100
    # On a GPU, Adam moves only the splats the current photo shows (gsplat's SelectiveAdam). With plain
    # Adam, a splat no photo has shown for a while still gets the regularizers' small nudges, at full step
    # size: its opacity collapses and MCMC moves it elsewhere. A whole home, each room out of view most
    # of the time, then forgets rooms faster than it learns them.
    visible_adam: bool = True
    # The rooms' shape (shell.py). Splats within `shell_snap` m of a wall, floor or ceiling are put on
    # it, `shell_thickness` m thick at most (0: off); no splat longer than `max_anisotropy` times its
    # middle axis (0: no limit); splats within `floater_radius` m of a camera and away from the
    # painted surfaces are cleared while splats are still being moved around (0: off).
    shell_snap: float = 0.025
    shell_thickness: float = 0.002
    max_anisotropy: float = 6.0
    floater_radius: float = 0.3
    # Photos smeared by the phone moving (sharpness.py). "kernel": a photo smeared `blur_min_px` px or
    # more (at training size, from its turn rate, speed and exposure) is compared with the render
    # smeared the same way, along the direction (of `blur_angles` tried) that matches it best, found
    # at each of `blur_direction_steps` (none before the first: the splats take shape first). Smears
    # are capped at `blur_max_px`. "sample": each photo's say is how close it comes to the sharpest
    # photo of the same surfaces, a smear of `blur_half_px` px more than theirs roughly halving it,
    # and photos are drawn in proportion to say ** `blur_power`, at least `blur_floor`. "off": every
    # photo as it is, equally (the trainer before both).
    blur_model: str = "kernel"
    blur_min_px: float = 1.0
    blur_max_px: float = 48.0
    blur_angles: int = 12
    blur_direction_steps: tuple[int, ...] = (4000, 12000)
    blur_half_px: float = 1.0
    blur_power: float = 2.0
    blur_floor: float = 0.02
    # Every nth photo is left out of training and scored at the end (0: train on all).
    holdout_every: int = 0
    strategy: str = "auto"  # "mcmc" (needs CUDA), "default", or "auto"
    seed: int = 0
    progress_every: int = 250


@dataclass
class Result:
    splats: dict[str, torch.Tensor]
    sh_degree: int
    stats: dict = field(default_factory=dict)


def quats_from_normals(n: np.ndarray) -> np.ndarray:
    """wxyz quaternions turning +z onto each normal."""
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    q = np.stack([1 + n[:, 2], -n[:, 1], n[:, 0], np.zeros(len(n))], 1)
    flipped = n[:, 2] < -0.9999
    q[flipped] = [0, 1, 0, 0]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def init_splats(capture: Capture, cfg: TrainConfig, device: torch.device, rng: np.random.Generator) -> torch.nn.ParameterDict:
    xyz, normal, rgb = capture.seeds_xyz, capture.seeds_normal, capture.seeds_rgb
    s = capture.seed_spacing
    if len(xyz) > cfg.max_gaussians:
        # Fewer seeds than the scan made: spread wider, so the discs still cover the surfaces.
        s *= float(np.sqrt(len(xyz) / cfg.max_gaussians))
        keep = rng.choice(len(xyz), cfg.max_gaussians, replace=False)
        xyz, normal, rgb = xyz[keep], normal[keep], rgb[keep]
    n = len(xyz)
    # Discs on the surface: half the seed spacing across, a tenth of it thick.
    scales = np.log(np.tile([0.5 * s, 0.5 * s, 0.1 * s], (n, 1)))
    colors = torch.zeros((n, (cfg.sh_degree + 1) ** 2, 3))
    colors[:, 0] = rgb_to_sh(torch.from_numpy(rgb.astype(np.float32) / 255))
    params = {
        "means": torch.from_numpy(xyz.astype(np.float32)),
        "scales": torch.from_numpy(scales.astype(np.float32)),
        "quats": torch.from_numpy(quats_from_normals(normal.astype(np.float64)).astype(np.float32)),
        "opacities": torch.logit(torch.full((n,), cfg.init_opacity)),
        "sh0": colors[:, :1].contiguous(),
        "shN": colors[:, 1:].contiguous(),
    }
    return torch.nn.ParameterDict({k: torch.nn.Parameter(v.to(device)) for k, v in params.items()})


def rotation_6d_to_matrix(d6: torch.Tensor) -> torch.Tensor:
    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1)
    b2 = F.normalize(a2 - (b1 * a2).sum(-1, keepdim=True) * b1, dim=-1)
    b3 = torch.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-2)


class PoseAdjust(torch.nn.Module):
    """A small pose correction per photo, in the camera's own frame (gsplat's CameraOptModule)."""

    def __init__(self, n: int):
        super().__init__()
        self.embeds = torch.nn.Embedding(n, 9)
        torch.nn.init.zeros_(self.embeds.weight)
        self.register_buffer("identity", torch.tensor([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]))

    def forward(self, camtoworld: torch.Tensor, index: int) -> torch.Tensor:
        delta = self.embeds.weight[index]
        transform = torch.eye(4, device=camtoworld.device)
        transform[:3, :3] = rotation_6d_to_matrix(delta[3:] + self.identity)
        transform[:3, 3] = delta[:3]
        return camtoworld @ transform


class Exposure(torch.nn.Module):
    """Each photo's colors as the camera saw them: a gain and an offset per color channel on the
    splats' colors (the phone's auto exposure and white balance). Their average over all the photos is
    held at none, so the splats keep the photos' average look, which is what the viewer shows."""

    MAX_GAIN = math.log(4.0)  # two stops either way (a phone facing a bright window darkens that much)
    MAX_OFFSET = 0.2

    def __init__(self, n: int):
        super().__init__()
        self.log_gain = torch.nn.Parameter(torch.zeros(n, 3))
        self.offset = torch.nn.Parameter(torch.zeros(n, 3))

    def forward(self, image: torch.Tensor, index: int) -> torch.Tensor:
        return image * torch.exp(self.log_gain[index]) + self.offset[index]

    def penalty(self) -> torch.Tensor:
        return (self.log_gain**2).mean() + (self.offset**2).mean()

    @torch.no_grad()
    def anchor(self):
        """After each step: the average back to none, each photo within two stops and a fifth."""
        self.log_gain.sub_(self.log_gain.mean(0)).clamp_(-self.MAX_GAIN, self.MAX_GAIN)
        self.offset.sub_(self.offset.mean(0)).clamp_(-self.MAX_OFFSET, self.MAX_OFFSET)


class ColorMatrix(torch.nn.Module):
    """The first worker's correction (TrainConfig.exposure_model "matrix"): a 3x3 color matrix and an
    offset per photo, held only by a weak penalty."""

    def __init__(self, n: int):
        super().__init__()
        self.matrix = torch.nn.Parameter(torch.eye(3).repeat(n, 1, 1))
        self.offset = torch.nn.Parameter(torch.zeros(n, 3))

    def forward(self, image: torch.Tensor, index: int) -> torch.Tensor:
        return image @ self.matrix[index].T + self.offset[index]

    def penalty(self) -> torch.Tensor:
        eye = torch.eye(3, device=self.matrix.device)
        return ((self.matrix - eye) ** 2).mean() + (self.offset**2).mean()

    def anchor(self):
        pass


def train(
    capture: Capture,
    cfg: TrainConfig,
    device: torch.device | str | None = None,
    progress: Callable[[float, str], None] | None = None,
    log: Callable[[str], None] = print,
    ai: AIVersion | None = None,
    ai_progress: Callable[[float, str], None] | None = None,
) -> Result:
    """Trains the splats. With `ai`, returns the AI-enhanced version, after handing the faithful one
    to `ai.on_main` (and reports the AI phase's progress to `ai_progress`)."""
    device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
    started = time.time()
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)

    # Photos at training size, kept on the device as bytes if they fit.
    cams = capture.cameras
    photos, Ks, people = [], [], []
    for cam in cams:
        rgb, K, mask = load_photo(cam, cfg.long_side)
        photos.append(torch.from_numpy(rgb))
        Ks.append(torch.tensor(K, dtype=torch.float32))
        people.append(None if mask is None else torch.from_numpy(mask))
    total = sum(p.numel() for p in photos)
    keep_on = device if total < 6e9 else torch.device("cpu")
    photos = [p.to(keep_on) for p in photos]
    people = [None if m is None else m.to(keep_on) for m in people]
    Ks = [K.to(device) for K in Ks]
    camtoworlds = torch.tensor(np.stack([c.camtoworld for c in cams]), dtype=torch.float32, device=device)
    test_ids = [i for i in range(len(cams)) if cfg.holdout_every and i % cfg.holdout_every == cfg.holdout_every // 2]
    train_ids = [i for i in range(len(cams)) if i not in set(test_ids)]

    # How smeared each photo is, and the order photos are drawn in (sharp ones more often with "sample").
    say, smear = photo_weights(cams, [training_size(c, cfg.long_side)[2] for c in cams], capture.seeds_xyz, cfg.blur_half_px, seed=cfg.seed)
    if cfg.blur_model != "sample":
        say = np.ones(len(cams))
    draw = np.maximum(say[train_ids] ** cfg.blur_power, cfg.blur_floor)
    order = rng.choice(np.asarray(train_ids), size=cfg.steps, p=draw / draw.sum())
    # With "kernel": the smeared photos, and each one's smear kernel once its direction is known.
    smeared = [i for i in train_ids if cfg.blur_model == "kernel" and np.isfinite(smear[i]) and smear[i] >= cfg.blur_min_px]
    kernels: dict[int, torch.Tensor] = {}
    if not np.isnan(smear).all():
        known = smear[~np.isnan(smear)]
        log(
            f"photo smear: median {np.median(known):.1f} px, 90% under {np.percentile(known, 90):.1f} px; "
            + (f"{len(smeared)} photos compared with the render smeared alike" if cfg.blur_model == "kernel" else "")
            + (f"{int((say[train_ids] < 0.5).sum())} of {len(train_ids)} photos mostly left to sharper ones" if cfg.blur_model == "sample" else "")
        )

    # The AI phase (enhance.py): its own draws, so the steps before it are the same with it or without.
    extra = ai.config.steps if ai else 0
    total = cfg.steps + extra
    if ai:
        ai_rng = np.random.default_rng(ai.config.seed)
        ai_order = ai_rng.choice(np.asarray(train_ids), size=extra, p=draw / draw.sum())
        ai_cleaned = ai_rng.random(extra) < ai.config.view_share
        ai_pick = ai_rng.integers(0, 1 << 30, size=extra)
        view_K = torch.tensor(intrinsics(ai.config), dtype=torch.float32, device=device)
    views, cleaned_views = [], []
    ai_started = 0.0

    # The spread of the cameras sets the step size for positions (gsplat's scene scale).
    centers = camtoworlds[:, :3, 3]
    spread = (centers - centers.mean(0)).norm(dim=1)
    scene_scale = 1.1 * float(spread.max().clamp(min=1.0))
    # MCMC's noise and scale penalty in gsplat's units (TrainConfig.normalize): per meter, how many.
    unit = 1.0 / max(0.3, float(spread.median())) if cfg.normalize else 1.0

    splats = init_splats(capture, cfg, device, rng)
    lrs = {
        "means": cfg.means_lr * scene_scale,
        "scales": cfg.scales_lr,
        "quats": cfg.quats_lr,
        "opacities": cfg.opacities_lr,
        "sh0": cfg.sh0_lr,
        "shN": cfg.shN_lr,
    }
    selective = cfg.visible_adam and device.type == "cuda"
    if selective:
        from gsplat.optimizers import SelectiveAdam

        optimizers = {k: SelectiveAdam([{"params": splats[k], "lr": lr, "name": k}], eps=1e-15, betas=(0.9, 0.999)) for k, lr in lrs.items()}
    else:
        optimizers = {k: torch.optim.Adam([{"params": splats[k], "lr": lr, "name": k}], eps=1e-15) for k, lr in lrs.items()}
    pose = PoseAdjust(len(cams)).to(device)
    exposure = (Exposure if cfg.exposure_model == "gain" else ColorMatrix)(len(cams)).to(device)
    pose_opt = torch.optim.Adam(pose.parameters(), lr=cfg.pose_lr, weight_decay=cfg.pose_reg)
    exposure_opt = torch.optim.Adam(exposure.parameters(), lr=cfg.exposure_lr)
    schedulers = [
        torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / cfg.steps)),
        torch.optim.lr_scheduler.ExponentialLR(pose_opt, gamma=0.01 ** (1.0 / cfg.steps)),
    ]

    kind = cfg.strategy if cfg.strategy != "auto" else ("mcmc" if device.type == "cuda" else "default")
    refine_stop = int(cfg.steps * cfg.refine_stop_frac)
    if kind == "mcmc":
        from gsplat.strategy import MCMCStrategy

        strategy = MCMCStrategy(
            cap_max=cfg.max_gaussians, refine_start_iter=cfg.refine_start, refine_stop_iter=refine_stop, refine_every=cfg.refine_every, noise_lr=5e5 * unit**2
        )
        state = strategy.initialize_state()
    else:
        from gsplat.strategy import DefaultStrategy

        strategy = DefaultStrategy(
            refine_start_iter=cfg.refine_start, refine_stop_iter=refine_stop, refine_every=cfg.refine_every, reset_every=max(3000, cfg.steps // 10)
        )
        state = strategy.initialize_state(scene_scale=scene_scale)
    strategy.check_sanity(splats, optimizers)

    lo = torch.tensor(capture.bounds_min, dtype=torch.float32, device=device) - cfg.bounds_margin
    hi = torch.tensor(capture.bounds_max, dtype=torch.float32, device=device) + cfg.bounds_margin
    shell = room_shell.from_capture(capture.rooms, capture.seeds_xyz, capture.seeds_normal, capture.seed_spacing) if cfg.shell_snap > 0 else None
    if shell is not None:
        shell = shell.to(device)
        log(f"room shell: {shell.walls} walls, {shell.flats} floors and ceilings")
    surfaces = room_shell.SurfaceIndex(torch.from_numpy(capture.seeds_xyz).to(device), 0.1) if cfg.floater_radius > 0 else None
    train_centers = centers[train_ids]
    cleared = 0
    recent: list[float] = []
    history: list[list[float]] = []  # [step, training PSNR], 50 times a run
    history_every = max(1, cfg.steps // 50)
    log(f"training {len(train_ids)} photos ({len(test_ids)} held out) at {cfg.long_side} px, {len(splats['means'])} splats to start, {kind} on {device}")

    def snapshot(steps: int) -> Result:
        """The splats as they'd be delivered now: a copy, on the shell and without needles, with the stats."""
        out = {k: v.detach().clone() for k, v in splats.items()}
        on_shell = room_shell.snap_to_shell(out, shell, cfg.shell_snap, cfg.shell_thickness) if shell is not None else 0
        if cfg.max_anisotropy > 0:
            room_shell.limit_anisotropy(out["scales"], cfg.max_anisotropy)
        stats = {
            "steps": steps,
            "gaussians": int(len(out["means"])),
            "trainPsnr": round(float(np.mean(recent)), 2),
            "seconds": round(time.time() - started, 1),
            "photos": len(cams),
            "longSide": cfg.long_side,
            "strategy": kind,
            "device": device.type,
            "poseShiftCm": round(float(pose.embeds.weight[:, :3].detach().norm(dim=1).mean()) * 100, 2),
            "unitsPerMeter": round(unit, 3),
            "exposureModel": cfg.exposure_model,
            "shellPlanes": 0 if shell is None else shell.walls + shell.flats,
            "onShell": on_shell,
            "floatersCleared": cleared,
            "visibleAdam": selective,
            "psnrHistory": history,
        }
        if not np.isnan(smear).all():
            known = smear[~np.isnan(smear)]
            stats["smearPx"] = {"median": round(float(np.median(known)), 2), "p90": round(float(np.percentile(known, 90)), 2), "max": round(float(known.max()), 2)}
            stats["blurModel"] = cfg.blur_model
            stats["smearedPhotosMatched"] = len(kernels)
            stats["photosLeftToSharper"] = int((say[train_ids] < 0.5).sum()) if cfg.blur_model == "sample" else 0
        if test_ids:
            scores = []
            with torch.no_grad():
                for i in test_ids:
                    image = photos[i].to(device).float() / 255.0
                    height, width = image.shape[:2]
                    render, _, _ = rasterize(out, torch.linalg.inv(camtoworlds[i]), Ks[i], width, height, cfg.sh_degree)
                    scores.append(psnr(render[0].clamp(0, 1), image))
            stats["testPsnr"] = round(float(np.mean(scores)), 2)
            stats["testPhotos"] = len(test_ids)
        return Result(splats={k: v.cpu() for k, v in out.items()}, sh_degree=cfg.sh_degree, stats=stats)

    for step in range(total):
        if ai and step == int(cfg.steps * 0.95) and hasattr(ai.fixer, "prepare"):
            ai.fixer.prepare()  # e.g. start the fixer's GPU now, so it's up when it's needed
        if ai and step == cfg.steps:
            main = snapshot(cfg.steps)
            log(f"faithful version: {main.stats}")
            if ai.on_main:
                ai.on_main(main)
            ai_started = time.time()
            views = choose_views(capture, ai.config, ai_rng)
            if not views:
                raise RuntimeError("no room to walk around in the capture for the AI-enhanced version")
            log(f"AI version: {len(views)} views, {ai.config.rounds} rounds of {ai.config.steps_per_round} steps, {ai.fixer.name}")
            if kind == "mcmc":
                # Dead splats may move again, to where the cleaned views want something.
                strategy.refine_stop_iter = total - ai.config.steps_per_round // 2
        if ai and step >= cfg.steps and (step - cfg.steps) % ai.config.steps_per_round == 0:
            # A round: the views a little further from the photos, rendered, cleaned up, trained on.
            r = (step - cfg.steps) // ai.config.steps_per_round
            poses = [between(v, (r + 1) / ai.config.rounds) for v in views]
            renders = []
            with torch.no_grad():
                gray = torch.full((3,), 0.5, device=device)
                for c2w in poses:
                    shown, _, _ = rasterize(splats, torch.linalg.inv(torch.tensor(c2w, dtype=torch.float32, device=device)), view_K, ai.config.width, ai.config.height, cfg.sh_degree, background=gray)
                    renders.append((shown[0].clamp(0, 1) * 255).round().byte().cpu().numpy())
            fixed = ai.fixer(renders)
            for c2w, image in zip(poses, fixed):
                if image.shape != (ai.config.height, ai.config.width, 3):
                    raise RuntimeError(f"the fixer answered {image.shape} for a {ai.config.width}x{ai.config.height} view")
                viewmat = torch.linalg.inv(torch.tensor(c2w, dtype=torch.float32, device=device))
                cleaned_views.append((viewmat, torch.from_numpy(np.array(image, dtype=np.uint8)).to(keep_on)))
            log(f"AI round {r + 1}: {len(poses)} views cleaned up, {len(cleaned_views)} in all")
        if smeared and step in cfg.blur_direction_steps:
            # Which way each smeared photo is smeared: the direction that makes the render look most like it.
            with torch.no_grad():
                for j in smeared:
                    photo = photos[j].to(device).float() / 255.0
                    shown, _, _ = rasterize(splats, torch.linalg.inv(pose(camtoworlds[j], j)), Ks[j], photo.shape[1], photo.shape[0], min(step // cfg.sh_degree_interval, cfg.sh_degree))
                    keep = None if people[j] is None else (~people[j].to(device)).float()[..., None]
                    length = float(min(smear[j], cfg.blur_max_px))
                    kernels[j] = line_kernel(length, find_direction(exposure(shown[0], j), photo, length, cfg.blur_angles, keep), device)
        view = None  # a cleaned view instead of a photo (the AI phase)
        if step < cfg.steps:
            i = int(order[step])
        else:
            j = step - cfg.steps
            i = int(ai_order[j])
            if ai_cleaned[j] and cleaned_views:
                view = cleaned_views[int(ai_pick[j]) % len(cleaned_views)]
        degree = min(step // cfg.sh_degree_interval, cfg.sh_degree)
        background = torch.rand(3, device=device)
        if view is not None:
            # As the fixer cleaned it up: the splats' own colors, no photo's exposure or smear.
            image = view[1].to(device).float() / 255.0
            render, alpha, info = rasterize(splats, view[0], view_K, image.shape[1], image.shape[0], degree, background=background)
            strategy.step_pre_backward(splats, optimizers, state, step, info)
            predicted = render[0]
            l1 = torch.abs(predicted - image).mean()
            loss = ai.config.view_weight * ((1 - cfg.ssim_lambda) * l1 + cfg.ssim_lambda * (1 - ssim(predicted[None], image[None])))
        else:
            image = photos[i].to(device).float() / 255.0
            height, width = image.shape[:2]
            c2w = pose(camtoworlds[i], i)
            viewmat = torch.linalg.inv(c2w)
            render, alpha, info = rasterize(splats, viewmat, Ks[i], width, height, degree, background=background)
            strategy.step_pre_backward(splats, optimizers, state, step, info)
            predicted = exposure(render[0], i)
            if i in kernels:
                predicted = smear_image(predicted, kernels[i])

            mask = people[i]
            if mask is not None:
                keep = (~mask.to(device)).float()[..., None]
                l1 = (torch.abs(predicted - image) * keep).sum() / (keep.sum() * 3).clamp(min=1)
                # SSIM over people too would pull on them: show it the photo there instead.
                compared = predicted * keep + image * (1 - keep)
            else:
                l1 = torch.abs(predicted - image).mean()
                compared = predicted
            loss = (1 - cfg.ssim_lambda) * l1 + cfg.ssim_lambda * (1 - ssim(compared[None], image[None]))
        if kind == "mcmc":
            loss = loss + cfg.opacity_reg * torch.sigmoid(splats["opacities"]).mean() + cfg.scale_reg * unit * torch.exp(splats["scales"]).mean()
        loss = loss + cfg.exposure_reg * exposure.penalty()
        loss.backward()

        if selective:
            # Which splats this photo shows: a footprint on screen (radii: [camera, splat, (x, y)]).
            seen = info["radii"] > 0
            visible = (seen.all(-1) if seen.dim() == 3 else seen).any(0)
            for opt in optimizers.values():
                opt.step(visible)
                opt.zero_grad(set_to_none=True)
        else:
            for opt in optimizers.values():
                opt.step()
                opt.zero_grad(set_to_none=True)
        for opt in (pose_opt, exposure_opt):
            opt.step()
            opt.zero_grad(set_to_none=True)
        exposure.anchor()
        for scheduler in schedulers:
            scheduler.step()
        if kind == "mcmc":
            strategy.step_post_backward(splats, optimizers, state, step, info, lr=schedulers[0].get_last_lr()[0])
        else:
            strategy.step_post_backward(splats, optimizers, state, step, info, packed=False)

        if cfg.max_anisotropy > 0:
            room_shell.limit_anisotropy(splats["scales"], cfg.max_anisotropy)
        if step % cfg.refine_every == 0 and step > 0:
            # Splats far outside the home: made transparent, so the strategy drops or reuses them.
            with torch.no_grad():
                means = splats["means"]
                outside = ((means < lo) | (means > hi)).any(dim=1)
                if outside.any():
                    splats["opacities"][outside] = -10.0
            if shell is not None:
                room_shell.snap_to_shell(splats, shell, cfg.shell_snap, cfg.shell_thickness)
            if surfaces is not None and (step < refine_stop or step >= cfg.steps):
                cleared += room_shell.clear_floaters(splats, train_centers, surfaces, cfg.floater_radius)

        if view is None:  # how well the splats fit the photos
            with torch.no_grad():
                recent.append(psnr(predicted.clamp(0, 1), image))
                recent = recent[-200:]
        if step % history_every == 0 or step == total - 1:
            history.append([step + 1, round(float(np.mean(recent)), 2)])
        if step < cfg.steps and progress and (step % cfg.progress_every == 0 or step == cfg.steps - 1):
            progress((step + 1) / cfg.steps, f"step {step + 1} of {cfg.steps}, {len(splats['means'])} splats, {np.mean(recent):.1f} dB")
        if step >= cfg.steps and ai_progress and ((step - cfg.steps) % cfg.progress_every == 0 or step == total - 1):
            ai_progress((step - cfg.steps + 1) / extra, f"round {(step - cfg.steps) // ai.config.steps_per_round + 1} of {ai.config.rounds}, {np.mean(recent):.1f} dB on the photos")

    result = snapshot(total)
    if ai:
        result.stats.update(
            variant="ai",
            fixer=ai.fixer.name,
            aiViews=len(views),
            aiRounds=ai.config.rounds,
            aiSteps=extra,
            aiCleanedViews=len(cleaned_views),
            aiSeconds=round(time.time() - ai_started, 1),
        )
    log(f"done: {result.stats}")
    return result
