"""Photo spots (docs/remaster.md §4.6): where the photos were taken, the photos themselves.

The phone takes a photo every second or two as the realtor walks. Photos taken within `spacing` of each
other (across the floor) make a spot, at the middle of where they were taken. From each spot the
remaster renders a cube of six square views of the finished model, and in each view paints what the
photos saw in place of the model's skins: each pixel from the photos that saw the same spot on the
model from nearly the same direction (by its angle off the spot's line of sight), with each photo's
color and alignment as the skins learned them, so the photos agree with each other and with the
model. Where no photo saw it, the model shows. The viewer projects these views onto the model from the
spot (TourScene's photo spots), so at a spot buyers see the photos, and between spots the model.

The cube's faces follow OpenGL's cube-map layout (WebGL samples them as stored), in one JPEG per spot:
a 3 × 2 grid, +x −x +y over −y +z −z.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from atrium_photoreal.capture import Capture, load_photo
from atrium_photoreal.sharpness import smear_px

from .scene import Mesh
from .views import Caster, render

FACES = ("px", "nx", "py", "ny", "pz", "nz")


@dataclass
class SpotConfig:
    spacing: float = 1.0  # photos within this of a spot's first one (meters across the floor) join it
    clearance: float = 0.25  # a spot this close to the model's surfaces isn't used
    face: int = 1024  # pixels on a side of each cube face (a phone keeps a few spots in memory)
    long_side: int = 1920  # photos are read at this size
    candidates: int = 24  # photos considered for each spot: its own, then the nearest
    reach: float = 3.5  # ... taken within this of it
    sigma: float = 8.0  # degrees: a photo's say fades with its angle off the spot's line of sight
    full: float = 0.5  # the photo weight at which a pixel is all photo
    feather: float = 0.04  # of a photo's long side: its say fades in from its border
    agree_abs: float = 0.03  # a photo sees a point if the model's depth there agrees within this
    agree_rel: float = 0.02  # ... plus this of the distance
    quality: int = 85
    max_spots: int = 200
    cache: int = 48  # photos kept in memory between spots


@dataclass
class Spot:
    position: np.ndarray
    cameras: list = field(default_factory=list)


def face_directions(face: int, n: int) -> np.ndarray:
    """(n, n, 3) unit directions of a cube face's pixels (rows down, columns across), OpenGL's layout:
    s and t run from the stored image's top-left corner."""
    t, s = np.meshgrid((np.arange(n) + 0.5) / n * 2 - 1, (np.arange(n) + 0.5) / n * 2 - 1, indexing="ij")
    one = np.ones_like(s)
    d = [
        np.stack([one, -t, -s], -1),  # +x
        np.stack([-one, -t, s], -1),  # -x
        np.stack([s, one, t], -1),  # +y
        np.stack([s, -one, -t], -1),  # -y
        np.stack([s, -t, one], -1),  # +z
        np.stack([-s, -t, -one], -1),  # -z
    ][face]
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def cube_lookup(faces: np.ndarray, d: np.ndarray) -> np.ndarray:
    """Colors of a cube ((6, n, n, C)) in directions (N, 3), nearest pixel, as WebGL samples it."""
    n = faces.shape[1]
    ax = np.abs(d)
    major = ax.argmax(1)
    out = np.zeros((len(d), faces.shape[-1]), faces.dtype)
    for axis in range(3):
        for sign, face in ((1, 2 * axis), (-1, 2 * axis + 1)):
            sel = (major == axis) & (np.sign(d[:, axis]) == sign)
            if not sel.any():
                continue
            x, y, z = (d[sel, k] / ax[sel, axis] for k in range(3))
            sc, tc = {0: (-z, -y), 1: (z, -y), 2: (x, z), 3: (x, -z), 4: (x, -y), 5: (-x, -y)}[face]
            col = np.clip(((sc + 1) / 2 * n).astype(int), 0, n - 1)
            row = np.clip(((tc + 1) / 2 * n).astype(int), 0, n - 1)
            out[sel] = faces[face, row, col]
    return out


def choose(mesh: Mesh, capture: Capture, cfg: SpotConfig, caster: Caster | None = None) -> list[Spot]:
    """The spots: the photos in the order they were taken, each joining the first spot within `spacing`
    (and half a meter in height) or starting one; each spot at the middle of its photos, if that's
    clear of the model's surfaces."""
    caster = caster or Caster.of(mesh)
    spots: list[Spot] = []
    anchors: list[np.ndarray] = []
    for cam in capture.cameras:
        p = cam.camtoworld[:3, 3].astype(np.float64)
        for spot, anchor in zip(spots, anchors):
            if math.hypot(p[0] - anchor[0], p[2] - anchor[2]) < cfg.spacing and abs(p[1] - anchor[1]) < 0.5:
                spot.cameras.append(cam)
                break
        else:
            spots.append(Spot(p, [cam]))
            anchors.append(p)
    # Clear of the surfaces: rays every way from the middle.
    dirs = np.array([d for d in np.ndindex(3, 3, 3) if d != (1, 1, 1)], np.float64) - 1
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    out = []
    for spot in spots:
        spot.position = np.mean([c.camtoworld[:3, 3] for c in spot.cameras], axis=0)
        t, _, _ = caster.rays(np.broadcast_to(spot.position, dirs.shape).astype(np.float32), dirs.astype(np.float32))
        if np.min(t) >= cfg.clearance:
            out.append(spot)
    return out[: cfg.max_spots]


class Photos:
    """The photos (as the skins saw them: sharpened where they were) and the model's depth at each, on
    the device, a few dozen at a time."""

    def __init__(self, mesh: Mesh, caster: Caster, cfg: SpotConfig, device: str, sharpened: dict | None, disagree: dict | None):
        self.caster, self.cfg, self.device = caster, cfg, device
        self.sharpened, self.disagree = sharpened or {}, disagree or {}
        self.cache: dict[str, tuple] = {}

    def get(self, cam):
        if cam.name in self.cache:
            return self.cache[cam.name]
        rgb, K, people = load_photo(cam, self.cfg.long_side)
        h, w = rgb.shape[:2]
        if cam.name in self.sharpened:
            rgb = np.asarray(Image.fromarray(np.asarray(self.sharpened[cam.name], np.uint8)).resize((w, h), Image.LANCZOS))
        dk = K.copy()
        dk[:2] *= 0.5
        depth = self.caster.view(dk, cam.camtoworld, max(1, w // 2), max(1, h // 2)).depth
        quiet = np.zeros((h, w), bool) if people is None else people
        if cam.name in self.disagree:
            m = self.disagree[cam.name]
            quiet |= np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize((w, h), Image.NEAREST)) > 127
        t = lambda a: torch.from_numpy(np.ascontiguousarray(a)).to(self.device)  # noqa: E731
        entry = (t(rgb.astype(np.float32) / 255).permute(2, 0, 1)[None], K, t(depth.astype(np.float32))[None, None], t(quiet.astype(np.float32))[None, None], w, h)
        if len(self.cache) >= self.cfg.cache:
            self.cache.pop(next(iter(self.cache)))
        self.cache[cam.name] = entry
        return entry


def sample(image: torch.Tensor, px: torch.Tensor, py: torch.Tensor, w: int, h: int, mode: str = "bilinear") -> torch.Tensor:
    """(N, C) values of a (1, C, H', W') image at pixels (x, y) of a w × h photo (scaled to fit)."""
    grid = torch.stack([px / w * 2 - 1, py / h * 2 - 1], -1)[None, None]
    return F.grid_sample(image, grid, mode=mode, padding_mode="border", align_corners=False)[0, :, 0].T


def paint_face(spot: Spot, face: int, mesh: Mesh, caster: Caster, photos: Photos, candidates: list, fixes: dict, cfg: SpotConfig) -> np.ndarray:
    """One cube face of a spot: (n, n, 3) uint8."""
    from .views import Hits, surface_points

    n = cfg.face
    d = face_directions(face, n).reshape(-1, 3)
    t, tri, bary = caster.rays(np.broadcast_to(spot.position, d.shape).astype(np.float32), d.astype(np.float32))
    hits = Hits(tri.reshape(n, n), bary.reshape(n, n, 2), t.reshape(n, n))
    base = render(mesh, hits, background=(0.5, 0.5, 0.5)).reshape(-1, 3)
    hit = tri >= 0
    dev = photos.device
    points = torch.from_numpy(surface_points(mesh, hits).reshape(-1, 3)[hit]).to(dev, torch.float32)
    ray = torch.from_numpy(d[hit]).to(dev, torch.float32)
    total = torch.zeros(len(points), 3, device=dev)
    weight = torch.zeros(len(points), device=dev)
    sigma = math.radians(cfg.sigma)
    for cam in candidates:
        image, K, depth, quiet, w, h = photos.get(cam)
        c2w = torch.from_numpy(cam.camtoworld.astype(np.float32)).to(dev)
        local = (points - c2w[:3, 3]) @ c2w[:3, :3]
        z = local[:, 2]
        front = z > 0.05
        u = K[0, 0] * local[:, 0] / z.clamp(min=1e-3) + K[0, 2]
        v = K[1, 1] * local[:, 1] / z.clamp(min=1e-3) + K[1, 2]
        inside = front & (u >= 0) & (u < w) & (v >= 0) & (v < h)
        if not bool(inside.any()):
            continue
        modeled = sample(depth, u, v, w, h, "nearest")[:, 0]
        seen = inside & ((modeled - z).abs() <= cfg.agree_abs + cfg.agree_rel * z)
        seen &= sample(quiet, u, v, w, h, "nearest")[:, 0] < 0.5
        if not bool(seen.any()):
            continue
        # Where the photo shows it, as training lined the photo up (warp_image), in the skins' colors.
        M, b, warp = fixes.get(cam.name, (np.eye(3, dtype=np.float32), np.zeros(3, np.float32), np.zeros(4, np.float32)))
        s = max(w, h) / 1920.0
        cx, cy = w / 2, h / 2
        turn, zoom = float(warp[2]), float(warp[3])
        c, sn = math.cos(turn), math.sin(turn)
        wx = cx + (1 + zoom) * (c * (u - cx) - sn * (v - cy)) + float(warp[0]) * s
        wy = cy + (1 + zoom) * (sn * (u - cx) + c * (v - cy)) + float(warp[1]) * s
        color = sample(image, wx, wy, w, h)
        inverse = torch.from_numpy(np.linalg.inv(np.asarray(M, np.float64)).T.astype(np.float32)).to(dev)
        color = (color - torch.from_numpy(np.asarray(b, np.float32)).to(dev)) @ inverse
        # Its say: by the angle between its line of sight and the spot's, and away from its border.
        toward = points - c2w[:3, 3]
        cos = (F.normalize(toward, dim=1) * ray).sum(1).clamp(-1, 1)
        angle = torch.arccos(cos)
        border = torch.minimum(torch.minimum(u, w - u), torch.minimum(v, h - v)) / (cfg.feather * max(w, h))
        smear = smear_px(cam, w / cam.width) or 0.0
        say = torch.exp(-((angle / sigma) ** 2)) * border.clamp(0, 1) / (1 + 0.3 * smear)
        say = torch.where(seen, say, torch.zeros_like(say))
        total += color * say[:, None]
        weight += say
    out = base.copy()
    if len(points):
        blend = (weight / cfg.full).clamp(0, 1)[:, None]
        photo = total / weight.clamp(min=1e-6)[:, None]
        mixed = torch.from_numpy(base[hit]).to(dev) * (1 - blend) + photo * blend
        out[hit] = mixed.clamp(0, 1).cpu().numpy()
    return (out.reshape(n, n, 3) * 255 + 0.5).astype(np.uint8)


def grid_jpeg(faces: np.ndarray, quality: int) -> bytes:
    """The six faces in one JPEG: +x −x +y over −y +z −z."""
    n = faces.shape[1]
    sheet = np.zeros((2 * n, 3 * n, 3), np.uint8)
    for k in range(6):
        r, c = divmod(k, 3)
        sheet[r * n : (r + 1) * n, c * n : (c + 1) * n] = faces[k]
    out = io.BytesIO()
    Image.fromarray(sheet).save(out, "JPEG", quality=quality, subsampling=0)
    return out.getvalue()


def faces_of(jpeg: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(jpeg)) as im:
        sheet = np.asarray(im.convert("RGB"))
    n = sheet.shape[0] // 2
    return np.stack([sheet[(k // 3) * n : (k // 3 + 1) * n, (k % 3) * n : (k % 3 + 1) * n] for k in range(6)])


def run(
    mesh: Mesh,
    capture: Capture,
    fixes: dict,
    cfg: SpotConfig = SpotConfig(),
    device: str = "cpu",
    sharpened: dict | None = None,
    disagree: dict | None = None,
    log=print,
    progress=None,
) -> list[dict]:
    """The photo spots of the finished model: per spot its position, its cube as one JPEG and how many
    photos it holds."""
    caster = Caster.of(mesh)
    spots = choose(mesh, capture, cfg, caster)
    photos = Photos(mesh, caster, cfg, device, sharpened, disagree)
    centers = np.array([c.camtoworld[:3, 3] for c in capture.cameras])
    out = []
    with torch.no_grad():
        for k, spot in enumerate(spots):
            own = {c.name for c in spot.cameras}
            distance = np.linalg.norm(centers - spot.position, axis=1)
            order = [i for i in np.argsort(distance) if distance[i] <= cfg.reach or capture.cameras[i].name in own]
            candidates = [capture.cameras[i] for i in order if capture.cameras[i].name in own]
            candidates += [capture.cameras[i] for i in order if capture.cameras[i].name not in own][: max(0, cfg.candidates - len(candidates))]
            faces = np.stack([paint_face(spot, f, mesh, caster, photos, candidates, fixes, cfg) for f in range(6)])
            out.append({"position": [round(float(v), 4) for v in spot.position], "jpeg": grid_jpeg(faces, cfg.quality), "photos": len(spot.cameras)})
            if progress:
                progress((k + 1) / len(spots))
    log(f"spots: {len(out)} photo spots from {len(capture.cameras)} photos")
    return out
