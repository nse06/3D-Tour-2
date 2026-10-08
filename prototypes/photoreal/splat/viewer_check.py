"""Why splats can look worse in the page than in training: imitates three.js's GaussianSplat step by step.

  python splat/viewer_check.py ckpt.pt data [page-captures]

Renders the held-out views with the trainer's rasterizer, then adds what a viewer does differently,
one step at a time: the .spz round trip, three's 2σ cutoff, its opacity compensation for small
splats (from Mip-Splatting) and blending in linear light. The last line is the kernel the page uses
(tools/build_site.py: 3σ, sRGB blending). With captures from `tools/capture.mjs <port> <dir> splat`,
it also scores the page against each step: the closest step is what the page actually draws.
"""
import json
import math
import os
import sys

import numpy as np
import torch
from PIL import Image
from torch.utils.cpp_extension import load

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gs  # noqa: E402

NO_CAPS = {"GS_ALPHA_MIN": "0.0f", "GS_ALPHA_MAX": "1.0f", "GS_T_MIN": "-1.0f"}  # a GPU blends every fragment


def rasterizer(name, cutoff_sigma):
    d = os.path.join(HERE, "build-" + name)
    os.makedirs(d, exist_ok=True)
    flags = [f"-D{k}={v}" for k, v in NO_CAPS.items()] + [f"-DGS_POWER_MIN={-0.5 * cutoff_sigma ** 2}f"]
    return load(name="gsrast_" + name, sources=[os.path.join(HERE, "rasterize.cpp")], extra_cflags=["-O3", "-fopenmp", "-march=native", "-ffast-math"] + flags,
                extra_ldflags=["-fopenmp"], build_directory=d, verbose=False)


def spz_round_trip(g, min_opacity=0.02):
    """The splats as splat/export.py writes them and three's SPZLoader reads them back."""
    op = torch.sigmoid(g["opacity_logits"][:, 0])
    keep = op >= min_opacity
    q = g["quats"][keep] / g["quats"][keep].norm(dim=1, keepdim=True)
    q = torch.where(q[:, :1] < 0, -q, q)
    xyz = torch.clamp(torch.round((q[:, 1:] + 1) * 127.5), 0, 255) / 127.5 - 1
    sh = g["sh"][keep].clone()
    sh[:, 0] = (torch.clamp(torch.round((sh[:, 0] * 0.15 + 0.5) * 255), 0, 255) / 255 - 0.5) / 0.15
    sh[:, 1:] = (torch.clamp(torch.round(sh[:, 1:] * 128 + 128), 0, 255) - 128) / 128
    alpha = torch.clamp(torch.round(op[keep] * 255), 0, 255) / 255
    return {
        "means": torch.round(g["means"][keep].double() * 4096).float() / 4096,
        "log_scales": torch.clamp(torch.round((g["log_scales"][keep] + 10) * 16), 0, 255) / 16 - 10,
        "quats": torch.cat([(1 - (xyz * xyz).sum(1)).clamp_min(0).sqrt()[:, None], xyz], 1),
        "opacity_logits": torch.logit(alpha.clamp(1e-6, 1 - 1e-6))[:, None],
        "sh": sh,
    }


def srgb_to_linear(c):
    return torch.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = c.clamp(0, 1)
    return torch.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def render(g, cam, degree, bg, ext, fade_small=False, linear=False):
    """gs.render with a given rasterizer, three's opacity compensation and linear-light blending as options."""
    p = g["means"] @ cam.R.T + cam.t
    tx, ty = 1.3 * (cam.w / 2) / cam.fx, 1.3 * (cam.h / 2) / cam.fy
    idx = ((p[:, 2] > 0.1) & (p[:, 0].abs() < tx * p[:, 2] + 0.5) & (p[:, 1].abs() < ty * p[:, 2] + 0.5)).nonzero().squeeze(1)
    pc = p[idx]
    z = pc[:, 2]
    x, y = (pc[:, 0] / z).clamp(-tx, tx) * z, (pc[:, 1] / z).clamp(-ty, ty) * z
    means2d = torch.stack([cam.fx * pc[:, 0] / z + cam.cx, cam.fy * pc[:, 1] / z + cam.cy], dim=1)
    mm = gs.quat_to_rot(g["quats"][idx]) * g["log_scales"][idx].exp()[:, None, :]
    zero = torch.zeros_like(z)
    J = torch.stack([cam.fx / z, zero, -cam.fx * x / (z * z), zero, cam.fy / z, -cam.fy * y / (z * z)], dim=1).reshape(-1, 2, 3)
    T = J @ cam.R
    cov2 = T @ (mm @ mm.transpose(1, 2)) @ T.transpose(1, 2)
    a0, b, c0 = cov2[:, 0, 0], cov2[:, 0, 1], cov2[:, 1, 1]
    a, c = a0 + 0.3, c0 + 0.3
    det = (a * c - b * b).clamp_min(1e-12)
    conics = torch.stack([c / det, -b / det, a / det], dim=1)
    mid = 0.5 * (a + c)
    radii = (3.0 * (mid + (mid * mid - det).clamp_min(0.1).sqrt()).sqrt()).ceil().to(torch.int32)
    on = (means2d[:, 0] + radii > 0) & (means2d[:, 0] - radii < cam.w) & (means2d[:, 1] + radii > 0) & (means2d[:, 1] - radii < cam.h)
    radii = torch.where(on, radii, torch.zeros_like(radii))
    dirs = g["means"][idx] - cam.center
    colors = gs.sh_colors(g["sh"][idx], dirs / dirs.norm(dim=1, keepdim=True), degree).clamp(0, 1)
    opac = torch.sigmoid(g["opacity_logits"][idx]).squeeze(1)
    if fade_small:
        opac = opac * ((a0 * c0 - b * b) / det).clamp_min(0).sqrt()
    if linear:
        colors, bg = srgb_to_linear(colors), srgb_to_linear(bg)
    img = ext.forward(means2d.contiguous(), conics.contiguous(), colors.contiguous(), opac.contiguous(), z.contiguous(), radii, cam.w, cam.h, bg)[0]
    return linear_to_srgb(img) if linear else img.clamp(0, 1)


def to8(img):
    return torch.from_numpy((img.numpy() * 255 + 0.5).astype(np.uint8).astype(np.float32) / 255)


def load_png(path):
    im = Image.open(path).convert("RGB")
    return torch.from_numpy(np.asarray(im.crop((0, 0, 480, 360)) if im.size != (480, 360) else im, dtype=np.float32) / 255)


def psnr(a, b):
    return 10 * math.log10(1 / max(((a - b) ** 2).mean().item(), 1e-10))


if __name__ == "__main__":
    ckpt, data = sys.argv[1], sys.argv[2]
    page = sys.argv[3] if len(sys.argv) > 3 else None
    state = torch.load(ckpt)
    g, degree = state["params"], state.get("degree", 1)
    gq = spz_round_trip(g)
    two, three_sigma = rasterizer("cut2", 2.0), rasterizer("cut3", 3.0)
    steps = {
        "trainer": lambda cam, bg: gs.render(g, cam, degree=degree, bg=bg).clamp(0, 1),
        "+ .spz round trip": lambda cam, bg: render(gq, cam, degree, bg, gs._ext),
        "+ three's 2σ cutoff": lambda cam, bg: render(gq, cam, degree, bg, two),
        "+ fading small splats": lambda cam, bg: render(gq, cam, degree, bg, two, fade_small=True),
        "+ linear blending = three": lambda cam, bg: render(gq, cam, degree, bg, two, fade_small=True, linear=True),
        "page: 3σ, sRGB blending": lambda cam, bg: render(gq, cam, degree, bg, three_sigma),
    }
    tests = json.load(open(os.path.join(data, "test.json")))
    bg = torch.tensor([0.81, 0.886, 0.953])
    score = {k: [0.0, 0.0] for k in steps}
    page_photo = 0.0
    with torch.no_grad():
        for i, t in enumerate(tests):
            k = t["intrinsics"]
            cam = gs.Camera(t["transform"], k[0], k[4], k[6], k[7], t["width"], t["height"])
            photo = load_png(os.path.join(data, "test", f"{i:02d}.png"))
            shot = load_png(os.path.join(page, f"splat-{i:02d}.png")) if page else None
            if shot is not None:
                page_photo += psnr(shot, photo) / len(tests)
            for name, f in steps.items():
                im = to8(f(cam, bg))
                score[name][0] += psnr(im, photo) / len(tests)
                if shot is not None:
                    score[name][1] += psnr(im, shot) / len(tests)
    print(f"{len(g['means']):,} splats ({len(gq['means']):,} exported), SH degree {degree}; PSNR on {len(tests)} held-out views")
    for name, (vs_photo, vs_page) in score.items():
        print(f"  {name:28s} vs photo {vs_photo:6.2f}" + (f"   vs page {vs_page:6.2f}" if page else ""))
    if page:
        print(f"  {'page capture':28s} vs photo {page_photo:6.2f}")
