"""Skins trained on every photo (docs/remaster.md §2).

The phone paints each spot of the model from the one photo that sees it best (PhotoTexturing.swift): a
surface becomes a few patches, each from a single photo, with its exposure matched and its seams
leveled. Here the model's shapes stay as they are and its atlases are learned from all the photos at
once, by gradient descent, the way the photoreal splats are, except that nothing can move off the
surfaces: every photo pixel the model explains (the triangle and texel it sees come from ray casting,
views.py) pulls the texel it lands on toward its color. Each photo gets its own color correction (the
phone's auto exposure and white balance) and a small shift, turn and zoom (what lining the photos up on
the phone left), a smeared photo is compared with the render smeared the same way
(atrium_photoreal.sharpness), and where a photo shows people, a surface at a grazing angle, or the
edge of something (where a small error in the shapes would put one surface's color on another) it
says nothing. Where it's blown out (a window, a lamp) it says only that the surface is at least that
bright: counted like any other pixel, a photo brighter than the rest pulls a window's glass down to grey.

The atlases are learned at a finer texel than the phone painted (`scale`), as a pyramid of coarser and
coarser layers that add up, so broad corrections spread at once and fine detail follows; each pixel
reads the atlas at the coarseness its footprint covers (mipmaps), so a floor seen at a grazing angle
doesn't alias. Texels no photo saw keep the phone's colors (the fill, fill.py, takes them from there).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from scipy import ndimage

from atrium_photoreal.capture import Capture, load_photo
from atrium_photoreal.sharpness import find_direction, line_kernel, smear_image, smear_px

from .scene import Mesh
from .views import Caster, Hits, surface_uv


@dataclass
class SkinConfig:
    # Texels this many times finer than the phone's, within `max_texels` texels in all.
    scale: float = 2.0
    max_texels: int = 40_000_000
    long_side: int = 1920  # photos at up to this many pixels on their long side
    steps: int = 3000
    batch: int = 4  # photos per step, a `tile`-pixel square of each
    tile: int = 768
    lr: float = 0.01
    # Layers of the pyramid. One: coarser layers, each texel a block of the finest, take Adam-sized
    # steps for a whole block from a few pixels' say, and with hundreds of photos they drift into
    # colored blotches (round 1 on the synthetic apartment).
    levels: int = 1
    max_mip: int = 4
    # A pixel says nothing within `edge_px` pixels (at 1920 px; scaled with the photo) of a jump in depth
    # or between surfaces that meet at an angle, nor where it sees a surface more than `max_angle`
    # degrees off head-on.
    edge_px: float = 3.0
    max_angle: float = 78.0
    blur_min_px: float = 1.0  # photos smeared at least this much are compared with a smeared render
    align: bool = True  # learn each photo's small shift, turn and zoom
    color_prior: float = 0.05  # how strongly a photo's color correction stays near what it started at
    huber: float = 0.03
    clipped: float = 0.98  # a photo channel this bright (0-1) is blown out: the surface is at least that bright
    anneal: float = 0.1  # the learning rate eases down to this share of itself by the last step (cosine)
    confidence: float = 0.0  # texels whose photos' weight is below about this keep the painting's colors (0: off)
    seed: int = 0
    progress_every: int = 100


@dataclass
class View:
    """A photo (or a cleaned-up view, enhance.py) as training uses it, at training size. Kept small
    (15 bytes a pixel), on the training device or, when hundreds of photos wouldn't fit there, in
    memory, each step taking only the pieces it trains on to the device."""

    name: str
    image: torch.Tensor  # (H, W, 3) uint8
    valid: torch.Tensor  # (H, W) bool: the pixels that say something
    atlas: torch.Tensor  # (H, W) int16: the atlas each pixel sees (-1: none)
    uv: torch.Tensor  # (H, W, 2) float: where in it
    level: torch.Tensor  # (H, W) int8: the mipmap its footprint covers
    smear: float = 0.0  # pixels, at training size
    angle: float = 0.0  # radians, the smear's direction (found once the skins take shape)
    weight: float = 1.0
    learn_color: bool = True  # photos have their own exposure; cleaned views are already matched

    @property
    def shape(self) -> tuple[int, int]:
        return tuple(self.valid.shape)

    def photo(self, device, box=None) -> torch.Tensor:
        """The image (or its `box`) as floats 0-1 on `device`."""
        image = self.image if box is None else self.image[box]
        return image.to(device, non_blocking=True).float() / 255

    def piece(self, device, box=None) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        """valid, atlas, uv and level (over `box`) on `device`."""
        return tuple((t if box is None else t[box]).to(device, non_blocking=True) for t in (self.valid, self.atlas, self.uv, self.level))

    def region(self, device, box: tuple[int, int, int, int], margin: int) -> tuple[torch.Tensor, tuple[int, int]]:
        """The image around `box` (y0, x0, h, w), `margin` pixels wider each way (within the photo),
        as floats on `device`, and where it starts."""
        y0, x0, h, w = box
        H, W = self.shape
        oy, ox = max(0, y0 - margin), max(0, x0 - margin)
        return self.photo(device, (slice(oy, min(H, y0 + h + margin)), slice(ox, min(W, x0 + w + margin)))), (oy, ox)


def to_uint8(image) -> np.ndarray:
    image = np.asarray(image)
    return image if image.dtype == np.uint8 else (np.clip(image, 0, 1) * 255 + 0.5).astype(np.uint8)


def storage(capture: Capture, cfg: "SkinConfig", device: str, extra_pixels: int = 0) -> str:
    """Where the views are kept: on the training device if they take under 40% of its free memory,
    else in memory."""
    if not str(device).startswith("cuda") or not torch.cuda.is_available():
        return device
    pixels = extra_pixels
    for cam in capture.cameras:
        s = min(1.0, cfg.long_side / max(cam.width, cam.height))
        pixels += int(cam.width * s) * int(cam.height * s)
    free, _ = torch.cuda.mem_get_info()
    return device if pixels * 15 < 0.4 * free else "cpu"


@dataclass
class ExtraViews:
    """Views made during training from the skins themselves (fixviews.py): at each fraction of the
    steps in `at`, `make(render, round)` returns new views (in place of the last round's), which then
    make up `share` of what each step draws. `render(view)` is the view as the skins show it then."""

    at: list[float]
    share: float
    make: Callable[[Callable[[View], np.ndarray], int], list[View]]


@dataclass
class Result:
    mesh: Mesh  # the model with the trained atlases
    seen: list[np.ndarray]  # per atlas (S, S) float: how much photo weight landed on each texel
    stats: dict = field(default_factory=dict)
    # Per photo (by camera name): what training learned about it, to use it as the skins do (spots.py):
    # its color matrix and offset (photo ≈ skin @ M.T + b, sRGB 0-1) and its warp (warp_image).
    fixes: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = field(default_factory=dict)


def trained_size(mesh: Mesh, cfg: SkinConfig) -> list[int]:
    """Each atlas's side once trained: `scale` times the phone's, within the texel budget, a multiple of
    2^max_mip (so its mipmaps line up)."""
    total = sum(a.shape[0] * a.shape[1] for a in mesh.atlases)
    scale = min(cfg.scale, math.sqrt(cfg.max_texels / max(total, 1)))
    step = 2**cfg.max_mip
    return [max(step, int(round(a.shape[0] * max(scale, 1e-3) / step)) * step) for a in mesh.atlases]


def edges(hits: Hits, mesh: Mesh, normals: np.ndarray, radius: float) -> np.ndarray:
    """(H, W) bool: within `radius` pixels of a jump in depth (6 cm + 6%) or of a seam between surfaces
    that meet at more than 30 degrees."""
    d = np.where(hits.hit, hits.depth, 1e3)
    n = normals[np.where(hits.hit, hits.face, 0)]
    jump = np.zeros(d.shape, bool)
    for axis in (0, 1):
        a = d
        b = np.roll(d, -1, axis=axis)
        na, nb = n, np.roll(n, -1, axis=axis)
        cut = (np.abs(a - b) > 0.06 + 0.06 * np.minimum(a, b)) | ((na * nb).sum(-1) < math.cos(math.radians(30)))
        cut |= hits.hit != np.roll(hits.hit, -1, axis=axis)
        if axis == 0:
            cut[-1, :] = False
        else:
            cut[:, -1] = False
        jump |= cut | np.roll(cut, 1, axis=axis)
    if radius <= 0:
        return jump
    r = int(math.ceil(radius))
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    return ndimage.binary_dilation(jump, structure=(xx * xx + yy * yy) <= radius * radius + 1e-6)


def prepare_view(
    mesh: Mesh,
    caster: Caster,
    image: np.ndarray,
    K: np.ndarray,
    camtoworld: np.ndarray,
    cfg: SkinConfig,
    sizes: list[int],
    texel: np.ndarray,
    normals: np.ndarray,
    people: np.ndarray | None = None,
    name: str = "",
    device: str = "cpu",
    quiet_faces: np.ndarray | None = None,
) -> View:
    """A view as training uses it: which pixels say something, where in which atlas, at which mipmap."""
    h, w = image.shape[:2]
    hits = caster.view(K, camtoworld, w, h)
    atlas, uv = surface_uv(mesh, hits)
    face = np.where(hits.hit, hits.face, 0)
    # The ray through each pixel and the surface's normal: how slanted the surface is.
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    ray = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1) @ camtoworld[:3, :3].T
    ray /= np.linalg.norm(ray, axis=-1, keepdims=True)
    cos = np.abs((ray * normals[face]).sum(-1))
    valid = hits.hit & (atlas >= 0) & (cos >= math.cos(math.radians(cfg.max_angle)))
    valid &= ~edges(hits, mesh, normals, cfg.edge_px * max(w, h) / 1920)
    if people is not None:
        valid &= ~people
    if quiet_faces is not None:
        valid &= ~quiet_faces[face]
    # Footprint: a pixel's size on the surface (meters), in trained texels of its triangle.
    with np.errstate(divide="ignore", invalid="ignore"):
        footprint = np.where(hits.hit, hits.depth / K[0, 0] / np.maximum(cos, 0.25), 0.0)
        atlas_size = np.array([s for s in sizes] + [1])[np.where(atlas >= 0, atlas, len(sizes))]
        phone_size = np.array([a.shape[0] for a in mesh.atlases] + [1])[np.where(atlas >= 0, atlas, len(sizes))]
        texel_trained = texel[face] * phone_size / atlas_size
        texels = np.where(valid, footprint / texel_trained, 1.0)
    level = np.clip(np.round(np.log2(np.maximum(texels, 1.0))), 0, cfg.max_mip).astype(np.int8)
    pin = str(device) == "cpu" and torch.cuda.is_available()

    def t(x, dtype):
        x = np.ascontiguousarray(x)
        out = torch.as_tensor(x if x.flags.writeable else x.copy(), dtype=dtype, device=device)
        return out.pin_memory() if pin else out

    return View(
        name=name,
        image=t(to_uint8(image), torch.uint8),
        valid=t(valid, torch.bool),
        atlas=t(np.where(atlas >= 0, atlas, -1).astype(np.int16), torch.int16),
        uv=t(uv, torch.float32),
        level=t(level, torch.int8),
    )


def prepare_photos(
    mesh: Mesh,
    capture: Capture,
    cfg: SkinConfig,
    device: str = "cpu",
    photos: dict[str, np.ndarray] | None = None,
    log=print,
    residual: float = 1.0,
    quiet_faces: np.ndarray | None = None,
    disagree: dict[str, np.ndarray] | None = None,
    store: str | None = None,
) -> list[View]:
    """Every photo of the capture as a training view. `photos`: sharpened copies by camera name
    (cleanup.py), used in place of the files, whose smear counts `residual` times; `quiet_faces`: (F,)
    triangles no photo says anything about (a TV's screen); `disagree`: per photo, where its depth
    disagrees with the model's shapes (depth.py), any size: those pixels say nothing; `store`: where
    the views are kept (storage(); the training device by default)."""
    store = store or device
    caster = Caster.of(mesh)
    sizes = trained_size(mesh, cfg)
    texel = mesh.texel_size()
    normals = mesh.face_normals
    out = []
    for cam in capture.cameras:
        rgb, K, people = load_photo(cam, cfg.long_side)
        sharpened = photos is not None and cam.name in photos
        if sharpened:
            clean = photos[cam.name]
            if clean.shape[:2] != rgb.shape[:2]:
                clean = np.asarray(Image.fromarray(clean).resize((rgb.shape[1], rgb.shape[0]), Image.LANCZOS))
            rgb = clean
        view = prepare_view(mesh, caster, rgb, K, cam.camtoworld, cfg, sizes, texel, normals, people, cam.name, store, quiet_faces)
        view.smear = (smear_px(cam, rgb.shape[1] / cam.width) or 0.0) * (residual if sharpened else 1.0)
        if disagree is not None and cam.name in disagree:
            mask = disagree[cam.name]
            if mask.shape != tuple(view.valid.shape):
                mask = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize((view.valid.shape[1], view.valid.shape[0]), Image.NEAREST)) > 127
            view.valid &= ~torch.as_tensor(mask, device=view.valid.device)
        out.append(view)
    log(f"skins: {len(out)} photos, {sum(int(v.valid.sum()) for v in out):,} pixels that say something")
    return out


class Skins(torch.nn.Module):
    """The atlases as pyramids of layers that add up, and every view's color correction and alignment."""

    def __init__(self, initial: list[np.ndarray], sizes: list[int], levels: int, views: int):
        super().__init__()
        self.sizes = sizes
        self.layers = torch.nn.ParameterList()
        self.index: list[list[int]] = []
        for atlas, size in zip(initial, sizes):
            base = np.asarray(Image.fromarray((np.clip(atlas, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((size, size), Image.BICUBIC), np.float32) / 255
            ids = []
            for k in range(levels):
                s = max(1, size >> k)
                value = torch.from_numpy(base).permute(2, 0, 1)[None].contiguous() if k == 0 else torch.zeros(1, 3, s, s)
                self.layers.append(torch.nn.Parameter(value))
                ids.append(len(self.layers) - 1)
            self.index.append(ids)
        # Per view: its exposure and white balance (a gain per channel and an offset: a full color
        # matrix would let the skins trade colors with the photos, rainbows where few photos look),
        # and a shift (pixels at 1920), turn (radians) and zoom.
        self.gain = torch.nn.Parameter(torch.ones(views, 3))
        self.offset = torch.nn.Parameter(torch.zeros(views, 3))
        self.warp = torch.nn.Parameter(torch.zeros(views, 4))

    def texture(self, a: int) -> torch.Tensor:
        ids = self.index[a]
        size = self.sizes[a]
        out = self.layers[ids[0]]
        for i in ids[1:]:
            layer = self.layers[i]
            out = out + F.interpolate(layer, size=(size, size), mode="bilinear", align_corners=False)
        return out

    def mips(self, a: int, count: int) -> list[torch.Tensor]:
        out = [self.texture(a)]
        for _ in range(count):
            out.append(F.avg_pool2d(out[-1], 2))
        return out


class LazyAdam:
    """Adam for parameters most steps don't reach (texels the step's photos don't see, photos not in
    the step): only what a step's loss reaches moves, each by its own history. torch's Adam keeps
    moving every parameter on its momentum, and divides a rarely seen texel's next gradient by a
    variance that decayed meanwhile: kicks of tens of learning rates, colored noise in the skins."""

    def __init__(self, groups: list[tuple[list[torch.Tensor], float]], betas=(0.9, 0.999), eps: float = 1e-8):
        self.groups = [(list(params), lr) for params, lr in groups]
        self.b1, self.b2 = betas
        self.eps = eps
        self.scale = 1.0  # the schedule's share of each group's learning rate, this step
        self.state: dict[int, tuple[torch.Tensor, torch.Tensor, torch.Tensor]] = {}

    def zero_grad(self) -> None:
        for params, _ in self.groups:
            for p in params:
                p.grad = None

    @torch.no_grad()
    def step(self) -> None:
        for params, lr in self.groups:
            for p in params:
                if p.grad is None or lr <= 0:
                    continue
                if id(p) not in self.state:
                    self.state[id(p)] = tuple(torch.zeros(p.numel(), device=p.device, dtype=p.dtype) for _ in range(3))
                m, v, n = self.state[id(p)]
                g = p.grad.reshape(-1)
                idx = torch.nonzero(g).squeeze(1)
                if idx.numel() == 0:
                    continue
                gi = g[idx]
                ni = n[idx] + 1
                mi = self.b1 * m[idx] + (1 - self.b1) * gi
                vi = self.b2 * v[idx] + (1 - self.b2) * gi * gi
                n[idx], m[idx], v[idx] = ni, mi, vi
                step = lr * self.scale * (mi / (1 - self.b1**ni)) / ((vi / (1 - self.b2**ni)).sqrt() + self.eps)
                p.view(-1).index_add_(0, idx, -step)


def lookup(mips: list[list[torch.Tensor]], atlas: torch.Tensor, uv: torch.Tensor, level: torch.Tensor) -> torch.Tensor:
    """Colors (N, 3) at (N,) atlases, (N, 2) texture coordinates and (N,) mipmaps (bilinear within each)."""
    out = torch.zeros(len(atlas), 3, device=uv.device, dtype=uv.dtype)
    for a, levels in enumerate(mips):
        for k, image in enumerate(levels):
            sel = (atlas == a) & (level == k)
            if not bool(sel.any()):
                continue
            grid = (uv[sel] * 2 - 1).view(1, 1, -1, 2)
            out[sel] = F.grid_sample(image, grid, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].T
    return out


def warp_image(image: torch.Tensor, warp: torch.Tensor, box: tuple[int, int, int, int], full: tuple[int, int], origin: tuple[int, int] = (0, 0)) -> torch.Tensor:
    """The (H, W, 3) photo resampled over `box` (y0, x0, h, w) after a small shift (pixels at 1920),
    turn and zoom about its center: what the photo shows where the model expects it. `image` may be
    a piece of the photo starting at `origin` (y, x), wide enough for the warp."""
    y0, x0, h, w = box
    fh, fw = full
    oy, ox = origin
    ch, cw = image.shape[:2]
    s = max(fh, fw) / 1920.0
    yy, xx = torch.meshgrid(
        torch.arange(y0, y0 + h, device=image.device, dtype=image.dtype) + 0.5,
        torch.arange(x0, x0 + w, device=image.device, dtype=image.dtype) + 0.5,
        indexing="ij",
    )
    cx, cy = fw / 2, fh / 2
    dx, dy, turn, zoom = warp[0] * s, warp[1] * s, warp[2], warp[3]
    c, sn = torch.cos(turn), torch.sin(turn)
    px = cx + (1 + zoom) * (c * (xx - cx) - sn * (yy - cy)) + dx
    py = cy + (1 + zoom) * (sn * (xx - cx) + c * (yy - cy)) + dy
    grid = torch.stack([(px - ox) / cw * 2 - 1, (py - oy) / ch * 2 - 1], -1)[None]
    return F.grid_sample(image.permute(2, 0, 1)[None], grid, mode="bilinear", padding_mode="border", align_corners=False)[0].permute(1, 2, 0)


def train(
    mesh: Mesh,
    views: list[View],
    cfg: SkinConfig,
    device: str = "cpu",
    log: Callable[[str], None] = print,
    progress: Callable[[float], None] | None = None,
    extra: ExtraViews | None = None,
) -> Result:
    """Learns the atlases from the views (prepare_photos), and from `extra`'s views once they're made."""
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    sizes = trained_size(mesh, cfg)
    model = Skins(mesh.atlases, sizes, cfg.levels, len(views)).to(device)
    texture_params = list(model.layers.parameters())
    opt = LazyAdam([(texture_params, cfg.lr), ([model.gain, model.offset], cfg.lr * 0.1), ([model.warp], cfg.lr * 0.1 if cfg.align else 0.0)])
    # Each photo's exposure and white balance to start with: against the phone's painting (which
    # already evened the photos out), the ratio of their medians, channel by channel. Their average
    # stays the painting's throughout, so what the photos saw keeps the brightness of what they didn't.
    with torch.no_grad():
        mips0 = [model.mips(a, cfg.max_mip) for a in range(len(sizes))]
        for i, v in enumerate(views):
            valid, atlas, uv, level = v.piece(device)
            if not v.learn_color or int(valid.sum()) < 100:
                continue
            painted = lookup(mips0, atlas[valid], uv[valid], level[valid])
            seen = v.photo(device)[valid]
            model.gain[i] = (seen.median(0).values / painted.median(0).values.clamp(min=0.02)).clamp(0.5, 2.0)
        mips0 = None
        gain_mean = model.gain.mean(0).clone()
        gain_start = model.gain.detach().clone()
    weights = np.array([v.weight * max(1, int(v.valid.sum())) for v in views], dtype=np.float64)
    if weights.sum() <= 0:
        raise ValueError("no photo sees a textured surface")
    probs = weights / weights.sum()
    t0 = time.time()
    loss_ema = None
    extras: list[View] = []
    extra_probs = None
    rounds = {min(cfg.steps - 1, max(0, int(round(f * cfg.steps)))): k for k, f in enumerate(extra.at)} if extra else {}

    def find_directions() -> None:
        with torch.no_grad():
            mips = [model.mips(a, cfg.max_mip) for a in range(len(sizes))]
            for v in views:
                if v.smear < cfg.blur_min_px:
                    continue
                render = render_view(mips, v, device)
                v.angle = find_direction(render, v.photo(device), v.smear, keep=v.valid.to(device)[..., None].float())

    for step in range(cfg.steps):
        opt.scale = cfg.anneal + (1 - cfg.anneal) * 0.5 * (1 + math.cos(math.pi * step / max(1, cfg.steps)))
        if step in (cfg.steps // 5, cfg.steps // 2):
            find_directions()
        if step in rounds:
            with torch.no_grad():
                current = [model.mips(a, cfg.max_mip) for a in range(len(sizes))]
                extras = extra.make(lambda v: render_view(current, v, device).clamp(0, 1).cpu().numpy(), rounds[step])
            ew = np.array([v.weight * max(1, int(v.valid.sum())) for v in extras], dtype=np.float64)
            extra_probs = ew / ew.sum() if len(extras) and ew.sum() > 0 else None
            log(f"skins: round {rounds[step] + 1} of {len(rounds)}, {len(extras)} views where buyers walk")
        mips = [model.mips(a, cfg.max_mip) for a in range(len(sizes))]
        loss = torch.zeros((), device=device)
        count = 0
        n_extra = int(rng.binomial(cfg.batch, extra.share)) if extra_probs is not None else 0
        picks = [(int(i), views[int(i)], True) for i in rng.choice(len(views), size=min(cfg.batch - n_extra, len(views)), replace=False, p=probs)]
        if n_extra:
            picks += [(int(j), extras[int(j)], False) for j in rng.choice(len(extras), size=min(n_extra, len(extras)), replace=False, p=extra_probs)]
        for i, v, is_photo in picks:
            h, w = v.shape
            th, tw = min(cfg.tile, h), min(cfg.tile, w)
            y0, x0 = int(rng.integers(0, h - th + 1)), int(rng.integers(0, w - tw + 1))
            box = (slice(y0, y0 + th), slice(x0, x0 + tw))
            valid, atlas, uv, level = v.piece(device, box)
            if not bool(valid.any()):
                continue
            if cfg.align and is_photo:
                region, origin = v.region(device, (y0, x0, th, tw), 64)
                target = warp_image(region, model.warp[i], (y0, x0, th, tw), (h, w), origin)
            else:
                target = v.photo(device, box)
            colors = lookup(mips, atlas[valid], uv[valid], level[valid])
            colors = colors * model.gain[i] + model.offset[i] if is_photo and v.learn_color else colors
            if v.smear >= cfg.blur_min_px and step >= cfg.steps // 5:
                # Smear the render like the photo: the tile's other pixels from the photo itself.
                render = target.detach().clone()
                render[valid] = colors
                kernel = line_kernel(v.smear, v.angle, device)
                pad = kernel.shape[0] // 2
                smeared = smear_image(render, kernel)
                inner = valid.clone()
                if pad:
                    inner[:pad] = False
                    inner[-pad:] = False
                    inner[:, :pad] = False
                    inner[:, -pad:] = False
                if not bool(inner.any()):
                    continue
                seen = target[inner]
                diff = smeared[inner] - seen
            else:
                seen = target[valid]
                diff = colors - seen
            # A blown-out channel is wrong only where the render is darker.
            diff = torch.where(seen >= cfg.clipped, diff.clamp(max=0), diff)
            err = torch.sqrt(diff * diff + cfg.huber**2) - cfg.huber
            loss = loss + v.weight * err.mean()
            count += 1
        if count == 0:
            continue
        loss = loss / count
        # The step's photos' corrections stay near where they started (only theirs: a prior on every
        # photo every step would make every photo's gradient dense).
        mine = torch.tensor(sorted({i for i, _, is_photo in picks if is_photo}), device=device, dtype=torch.long)
        prior = cfg.color_prior * (((model.gain[mine] - gain_start[mine]) ** 2).mean() + (model.offset[mine] ** 2).mean()) + 1e-4 * (model.warp[mine] ** 2).sum() if len(mine) else 0.0
        total = loss + prior
        opt.zero_grad()
        total.backward()
        opt.step()
        with torch.no_grad():  # the photos' average exposure stays the painting's
            model.gain.mul_(gain_mean / model.gain.mean(0))
            model.offset.sub_(model.offset.mean(0))
        value = float(loss.detach())
        loss_ema = value if loss_ema is None else 0.95 * loss_ema + 0.05 * value
        if progress is not None and step % 10 == 0:
            progress(step / cfg.steps)
        if cfg.progress_every and step % cfg.progress_every == 0:
            log(f"skins: step {step}/{cfg.steps} loss {loss_ema:.4f} ({time.time() - t0:.0f} s)")

    with torch.no_grad():
        atlases = [model.texture(a)[0].permute(1, 2, 0).clamp(0, 1).cpu().numpy() for a in range(len(sizes))]
    gain, offset, warp = (t.detach().cpu().numpy() for t in (model.gain, model.offset, model.warp))
    color = np.stack([np.diag(g) for g in gain]) if len(gain) else np.zeros((0, 3, 3), np.float32)
    shift = round(float(np.linalg.norm(warp[:, :2], axis=1).mean()), 2) if len(views) else 0.0
    # The model and its optimizer's state go before the coverage count needs the room.
    opt = model = mips = loss = total = texture_params = current = gain_start = None  # noqa: F841
    if str(device).startswith("cuda"):
        torch.cuda.empty_cache()
    seen = coverage(views, sizes, device)
    if cfg.confidence > 0:
        # What few photos say is mostly their noise: such texels lean back to the painting.
        for a, (atlas, weight) in enumerate(zip(atlases, seen)):
            painted = np.asarray(Image.fromarray((np.clip(mesh.atlases[a], 0, 1) * 255 + 0.5).astype(np.uint8)).resize(atlas.shape[:2][::-1], Image.BICUBIC), np.float32) / 255
            trust = (weight / (weight + cfg.confidence))[..., None]
            atlases[a] = (painted + trust * (atlas - painted)).astype(np.float32)
    trained = Mesh(mesh.vertices, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, atlases, mesh.extras)
    stats = {
        "skinSteps": cfg.steps,
        "skinSeconds": round(time.time() - t0, 1),
        "skinLoss": round(loss_ema or 0.0, 5),
        "skinAtlases": sizes,
        "skinViews": len(views),
        "skinSeenShare": round(sum(int((s > 0).sum()) for s in seen) / max(1, sum(s.size for s in seen)), 4),  # of all texels
        "photoShiftPx": shift,
        "photoGainSpread": round(float(gain.std(0).mean()), 4) if len(gain) else 0.0,
    }
    if extra:
        stats["extraViews"] = len(extras)
        stats["extraRounds"] = len(rounds)
    fixes = {v.name: (color[i], offset[i], warp[i] if cfg.align else np.zeros(4, np.float32)) for i, v in enumerate(views) if v.learn_color}
    return Result(trained, seen, stats, fixes)


def render_view(mips: list[list[torch.Tensor]], v: View, device: str) -> torch.Tensor:
    """The view's pixels as the skins show them (the photo's own where they say nothing)."""
    out = v.photo(device)
    valid, atlas, uv, level = v.piece(device)
    out[valid] = lookup(mips, atlas[valid], uv[valid], level[valid])
    return out


def coverage(views: list[View], sizes: list[int], device: str = "cpu") -> list[np.ndarray]:
    """Per atlas, how much pixel weight landed on each texel (bilinear, at the finest level, as the
    skins read them): 0 where no view says anything. One view at a time, straight into the counts."""
    seen = [torch.zeros(s * s, device=device) for s in sizes]
    with torch.no_grad():
        for v in views:
            valid, atlas, uv, _ = v.piece(device)
            if not bool(valid.any()):
                continue
            atlas, uv = atlas[valid], uv[valid]
            for a, s in enumerate(sizes):
                sel = atlas == a
                if not bool(sel.any()):
                    continue
                # grid_sample's bilinear taps (align_corners=False, border padding) for these pixels.
                p = (uv[sel] * s - 0.5).clamp(0, s - 1)
                x0, y0 = p[:, 0].floor(), p[:, 1].floor()
                fx, fy = p[:, 0] - x0, p[:, 1] - y0
                x0, y0 = x0.long(), y0.long()
                x1, y1 = (x0 + 1).clamp(max=s - 1), (y0 + 1).clamp(max=s - 1)
                for xi, yi, w in ((x0, y0, (1 - fx) * (1 - fy)), (x1, y0, fx * (1 - fy)), (x0, y1, (1 - fx) * fy), (x1, y1, fx * fy)):
                    seen[a].index_add_(0, yi * s + xi, v.weight * w)
    return [c.view(s, s).cpu().numpy() for c, s in zip(seen, sizes)]