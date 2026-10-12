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
says nothing.

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

from atrium_photoreal.capture import Capture, Camera, load_photo
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
    levels: int = 4  # layers of the pyramid
    max_mip: int = 4
    # A pixel says nothing within `edge_px` pixels (at 1920 px; scaled with the photo) of a jump in depth
    # or between surfaces that meet at an angle, nor where it sees a surface more than `max_angle`
    # degrees off head-on.
    edge_px: float = 3.0
    max_angle: float = 78.0
    blur_min_px: float = 1.0  # photos smeared at least this much are compared with a smeared render
    align: bool = True  # learn each photo's small shift, turn and zoom
    color_prior: float = 0.05  # how strongly a photo's color correction stays near none
    huber: float = 0.03
    seed: int = 0
    progress_every: int = 100


@dataclass
class View:
    """A photo (or a cleaned-up view, enhance.py) as training uses it, at training size."""

    name: str
    image: torch.Tensor  # (H, W, 3) float 0-1
    valid: torch.Tensor  # (H, W) bool: the pixels that say something
    atlas: torch.Tensor  # (H, W) int64: the atlas each pixel sees (-1: none)
    uv: torch.Tensor  # (H, W, 2) float: where in it
    level: torch.Tensor  # (H, W) int64: the mipmap its footprint covers
    smear: float = 0.0  # pixels, at training size
    angle: float = 0.0  # radians, the smear's direction (found once the skins take shape)
    weight: float = 1.0
    learn_color: bool = True  # photos have their own exposure; cleaned views are already matched

    @property
    def shape(self) -> tuple[int, int]:
        return tuple(self.valid.shape)


@dataclass
class Result:
    mesh: Mesh  # the model with the trained atlases
    seen: list[np.ndarray]  # per atlas (S, S) float: how much photo weight landed on each texel
    stats: dict = field(default_factory=dict)


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
    # Footprint: a pixel's size on the surface (meters), in trained texels of its triangle.
    with np.errstate(divide="ignore", invalid="ignore"):
        footprint = np.where(hits.hit, hits.depth / K[0, 0] / np.maximum(cos, 0.25), 0.0)
        atlas_size = np.array([s for s in sizes] + [1])[np.where(atlas >= 0, atlas, len(sizes))]
        phone_size = np.array([a.shape[0] for a in mesh.atlases] + [1])[np.where(atlas >= 0, atlas, len(sizes))]
        texel_trained = texel[face] * phone_size / atlas_size
        texels = np.where(valid, footprint / texel_trained, 1.0)
    level = np.clip(np.round(np.log2(np.maximum(texels, 1.0))), 0, cfg.max_mip).astype(np.int64)
    t = lambda x, dtype: torch.as_tensor(np.ascontiguousarray(x), dtype=dtype, device=device)
    return View(
        name=name,
        image=t(image, torch.float32),
        valid=t(valid, torch.bool),
        atlas=t(atlas, torch.int64),
        uv=t(uv, torch.float32),
        level=t(level, torch.int64),
    )


def prepare_photos(mesh: Mesh, capture: Capture, cfg: SkinConfig, device: str = "cpu", photos: dict[str, np.ndarray] | None = None, log=print) -> list[View]:
    """Every photo of the capture as a training view. `photos`: cleaned-up copies by camera name
    (cleanup.py), used in place of the files."""
    caster = Caster.of(mesh)
    sizes = trained_size(mesh, cfg)
    texel = mesh.texel_size()
    normals = mesh.face_normals
    out = []
    for cam in capture.cameras:
        rgb, K, people = load_photo(cam, cfg.long_side)
        if photos is not None and cam.name in photos:
            clean = photos[cam.name]
            if clean.shape[:2] != rgb.shape[:2]:
                clean = np.asarray(Image.fromarray(clean).resize((rgb.shape[1], rgb.shape[0]), Image.LANCZOS))
            rgb = clean
        view = prepare_view(mesh, caster, rgb.astype(np.float32) / 255.0, K, cam.camtoworld, cfg, sizes, texel, normals, people, cam.name, device)
        view.smear = smear_px(cam, rgb.shape[1] / cam.width) or 0.0
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
                value = torch.from_numpy(base).permute(2, 0, 1)[None].clone() if k == 0 else torch.zeros(1, 3, s, s)
                self.layers.append(torch.nn.Parameter(value))
                ids.append(len(self.layers) - 1)
            self.index.append(ids)
        # Per view: a 3x3 color matrix and offset (identity at first), and a shift (pixels at 1920),
        # turn (radians) and zoom.
        self.color = torch.nn.Parameter(torch.eye(3).repeat(views, 1, 1))
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


def warp_image(image: torch.Tensor, warp: torch.Tensor, box: tuple[int, int, int, int], full: tuple[int, int]) -> torch.Tensor:
    """The (H, W, 3) photo resampled over `box` (y0, x0, h, w) after a small shift (pixels at 1920),
    turn and zoom about its center: what the photo shows where the model expects it."""
    y0, x0, h, w = box
    fh, fw = full
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
    grid = torch.stack([px / fw * 2 - 1, py / fh * 2 - 1], -1)[None]
    return F.grid_sample(image.permute(2, 0, 1)[None], grid, mode="bilinear", padding_mode="border", align_corners=False)[0].permute(1, 2, 0)


def train(
    mesh: Mesh,
    views: list[View],
    cfg: SkinConfig,
    device: str = "cpu",
    log: Callable[[str], None] = print,
    progress: Callable[[float], None] | None = None,
) -> Result:
    """Learns the atlases from the views (prepare_photos, plus any cleaned-up views)."""
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    sizes = trained_size(mesh, cfg)
    model = Skins(mesh.atlases, sizes, cfg.levels, len(views)).to(device)
    texture_params = list(model.layers.parameters())
    opt = torch.optim.Adam(
        [
            {"params": texture_params, "lr": cfg.lr},
            {"params": [model.color, model.offset], "lr": cfg.lr * 0.1},
            {"params": [model.warp], "lr": cfg.lr * 0.1 if cfg.align else 0.0},
        ]
    )
    weights = np.array([v.weight * max(1, int(v.valid.sum())) for v in views], dtype=np.float64)
    if weights.sum() <= 0:
        raise ValueError("no photo sees a textured surface")
    probs = weights / weights.sum()
    t0 = time.time()
    loss_ema = None

    def find_directions() -> None:
        with torch.no_grad():
            mips = [model.mips(a, cfg.max_mip) for a in range(len(sizes))]
            for v in views:
                if v.smear < cfg.blur_min_px:
                    continue
                render = render_view(mips, v)
                v.angle = find_direction(render, v.image, v.smear, keep=v.valid[..., None].float())

    for step in range(cfg.steps):
        if step in (cfg.steps // 5, cfg.steps // 2):
            find_directions()
        mips = [model.mips(a, cfg.max_mip) for a in range(len(sizes))]
        loss = torch.zeros((), device=device)
        count = 0
        for i in rng.choice(len(views), size=min(cfg.batch, len(views)), replace=False, p=probs):
            v = views[i]
            h, w = v.shape
            th, tw = min(cfg.tile, h), min(cfg.tile, w)
            y0, x0 = int(rng.integers(0, h - th + 1)), int(rng.integers(0, w - tw + 1))
            box = (slice(y0, y0 + th), slice(x0, x0 + tw))
            valid = v.valid[box]
            if not bool(valid.any()):
                continue
            target = warp_image(v.image, model.warp[i], (y0, x0, th, tw), (h, w)) if cfg.align else v.image[box]
            colors = lookup(mips, v.atlas[box][valid], v.uv[box][valid], v.level[box][valid])
            colors = colors @ model.color[i].T + model.offset[i] if v.learn_color else colors
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
                diff = smeared[inner] - target[inner]
            else:
                diff = colors - target[valid]
            err = torch.sqrt(diff * diff + cfg.huber**2) - cfg.huber
            loss = loss + v.weight * err.mean()
            count += 1
        if count == 0:
            continue
        loss = loss / count
        prior = cfg.color_prior * ((model.color - torch.eye(3, device=device)) ** 2).mean() + cfg.color_prior * (model.offset**2).mean()
        anchor = ((model.color.mean(0) - torch.eye(3, device=device)) ** 2).sum() + (model.offset.mean(0) ** 2).sum()
        total = loss + prior + anchor + 1e-4 * (model.warp**2).sum() / max(1, len(views))
        opt.zero_grad(set_to_none=True)
        total.backward()
        opt.step()
        value = float(loss.detach())
        loss_ema = value if loss_ema is None else 0.95 * loss_ema + 0.05 * value
        if progress is not None and step % 10 == 0:
            progress(step / cfg.steps)
        if cfg.progress_every and step % cfg.progress_every == 0:
            log(f"skins: step {step}/{cfg.steps} loss {loss_ema:.4f} ({time.time() - t0:.0f} s)")

    with torch.no_grad():
        atlases = [model.texture(a)[0].permute(1, 2, 0).clamp(0, 1).cpu().numpy() for a in range(len(sizes))]
    seen = coverage(views, sizes, device)
    trained = Mesh(mesh.vertices, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, atlases, mesh.extras)
    stats = {
        "skinSteps": cfg.steps,
        "skinSeconds": round(time.time() - t0, 1),
        "skinLoss": round(loss_ema or 0.0, 5),
        "skinAtlases": sizes,
        "skinViews": len(views),
        "skinSeenShare": round(float(np.mean([(s > 0).mean() for s in seen])) if seen else 0.0, 4),
        "photoShiftPx": round(float(model.warp.detach()[:, :2].norm(dim=1).mean()), 2) if len(views) else 0.0,
    }
    return Result(trained, seen, stats)


def render_view(mips: list[list[torch.Tensor]], v: View) -> torch.Tensor:
    """The view's pixels as the skins show them (the photo's own where they say nothing)."""
    out = v.image.clone()
    out[v.valid] = lookup(mips, v.atlas[v.valid], v.uv[v.valid], v.level[v.valid])
    return out


def coverage(views: list[View], sizes: list[int], device: str = "cpu") -> list[np.ndarray]:
    """Per atlas, how much pixel weight landed on each texel (bilinear, at the finest level): 0 where no
    view says anything."""
    seen = [torch.zeros(1, 1, s, s, device=device, requires_grad=True) for s in sizes]
    total = torch.zeros((), device=device)
    for v in views:
        if not bool(v.valid.any()):
            continue
        atlas, uv = v.atlas[v.valid], v.uv[v.valid]
        for a, image in enumerate(seen):
            sel = atlas == a
            if bool(sel.any()):
                grid = (uv[sel] * 2 - 1).view(1, 1, -1, 2)
                total = total + v.weight * F.grid_sample(image + 1, grid, mode="bilinear", padding_mode="border", align_corners=False).sum()
    if total.requires_grad:
        total.backward()
    return [(s.grad[0, 0].cpu().numpy() if s.grad is not None else np.zeros((s.shape[2], s.shape[3]))) for s in seen]
