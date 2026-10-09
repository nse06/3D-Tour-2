"""Renders splats from a camera: gsplat's CUDA rasterizer on a GPU; on a CPU (tests, tiny images
only) a dense PyTorch version of the same image formation, differentiable by autograd.

Splats: means (N, 3), quats (N, 4, wxyz, unnormalized), log scales (N, 3), opacity logits (N,),
SH coefficients (N, K, 3). Cameras: OpenCV world-to-camera `viewmat` (4, 4) and intrinsics K (3, 3).
"""

from __future__ import annotations

import math
from typing import Any

import torch
from torch import Tensor

SH_C0 = 0.28209479177387814


def rgb_to_sh(rgb: Tensor) -> Tensor:
    return (rgb - 0.5) / SH_C0


def rasterize(
    splats: dict[str, Tensor],
    viewmat: Tensor,
    K: Tensor,
    width: int,
    height: int,
    sh_degree: int,
    background: Tensor | None = None,
    absgrad: bool = False,
) -> tuple[Tensor, Tensor, dict[str, Any]]:
    """RGB (1, H, W, 3), alpha (1, H, W, 1) and gsplat's info dict (what densification reads)."""
    means = splats["means"]
    quats = splats["quats"]
    scales = torch.exp(splats["scales"])
    opacities = torch.sigmoid(splats["opacities"])
    colors = torch.cat([splats["sh0"], splats["shN"]], 1)
    backgrounds = background[None] if background is not None else None
    if means.is_cuda:
        from gsplat import rasterization

        return rasterization(
            means=means,
            quats=quats,
            scales=scales,
            opacities=opacities,
            colors=colors,
            viewmats=viewmat[None],
            Ks=K[None],
            width=width,
            height=height,
            sh_degree=sh_degree,
            backgrounds=backgrounds,
            packed=False,
            absgrad=absgrad,
            near_plane=0.01,
            far_plane=1e3,
        )
    return dense_rasterize(means, quats, scales, opacities, colors, viewmat, K, width, height, sh_degree, backgrounds)


def dense_rasterize(means, quats, scales, opacities, colors, viewmat, K, width, height, sh_degree, backgrounds):
    """gsplat's image formation, every splat against every pixel: for tests on tiny images."""
    from gsplat.cuda._torch_impl import _fully_fused_projection, _quat_scale_to_covar_preci, _spherical_harmonics

    quats = quats / quats.norm(dim=-1, keepdim=True)
    covars, _ = _quat_scale_to_covar_preci(quats, scales, compute_covar=True, compute_preci=False, triu=False)
    radii, means2d, depths, conics, _ = _fully_fused_projection(means, covars, viewmat[None], K[None], width, height, eps2d=0.3, near_plane=0.01, far_plane=1e3)
    means2d.retain_grad() if means2d.requires_grad else None
    campos = torch.inverse(viewmat)[:3, 3]
    dirs = means - campos
    rgb = torch.clamp_min(_spherical_harmonics(sh_degree, dirs, colors[:, : (sh_degree + 1) ** 2]) + 0.5, 0.0)  # (N, 3)

    valid = (radii[0] > 0).all(dim=-1)
    order = torch.argsort(torch.where(valid, depths[0], torch.full_like(depths[0], float("inf"))))
    order = order[: int(valid.sum())]
    ys, xs = torch.meshgrid(torch.arange(height, dtype=means.dtype) + 0.5, torch.arange(width, dtype=means.dtype) + 0.5, indexing="ij")
    px = torch.stack([xs.reshape(-1), ys.reshape(-1)], -1)  # (P, 2)
    m = means2d[0, order]
    a, b, c = conics[0, order, 0], conics[0, order, 1], conics[0, order, 2]
    d = px[None] - m[:, None]  # (n, P, 2)
    sigma = 0.5 * (a[:, None] * d[..., 0] ** 2 + c[:, None] * d[..., 1] ** 2) + b[:, None] * d[..., 0] * d[..., 1]
    alpha = torch.clamp(opacities[order, None] * torch.exp(-sigma), max=0.999)
    alpha = torch.where((sigma < 0) | (alpha < 1.0 / 255.0), torch.zeros_like(alpha), alpha)
    transmit = torch.cumprod(torch.cat([torch.ones_like(alpha[:1]), 1 - alpha], 0), 0)  # (n+1, P)
    weights = alpha * transmit[:-1]
    out = (weights[..., None] * rgb[order, None]).sum(0)  # (P, 3)
    if backgrounds is not None:
        out = out + transmit[-1][:, None] * backgrounds[0]
    image = out.reshape(1, height, width, 3)
    alphas = (1 - transmit[-1]).reshape(1, height, width, 1)
    info = {"means2d": means2d, "radii": radii, "depths": depths, "width": width, "height": height, "n_cameras": 1, "gaussian_ids": None}
    return image, alphas, info


def ssim(x: Tensor, y: Tensor, window: int = 11) -> Tensor:
    """SSIM of two (1, H, W, 3) images in [0, 1] (Gaussian window, 'valid' padding as gsplat's trainer)."""
    try:
        if x.is_cuda:
            from fused_ssim import fused_ssim

            return fused_ssim(x.permute(0, 3, 1, 2), y.permute(0, 3, 1, 2), padding="valid")
    except ImportError:
        pass
    x, y = x.permute(0, 3, 1, 2), y.permute(0, 3, 1, 2)
    window = min(window, x.shape[-1], x.shape[-2])
    g = torch.exp(-((torch.arange(window, dtype=x.dtype, device=x.device) - (window - 1) / 2) ** 2) / (2 * 1.5**2))
    g = (g / g.sum())[None]
    kernel = (g.T @ g)[None, None].repeat(3, 1, 1, 1)

    def blur(t):
        return torch.nn.functional.conv2d(t, kernel, groups=3)

    mx, my = blur(x), blur(y)
    vx, vy, cov = blur(x * x) - mx**2, blur(y * y) - my**2, blur(x * y) - mx * my
    c1, c2 = 0.01**2, 0.03**2
    s = ((2 * mx * my + c1) * (2 * cov + c2)) / ((mx**2 + my**2 + c1) * (vx + vy + c2))
    return s.mean()


def psnr(x: Tensor, y: Tensor) -> float:
    mse = torch.mean((x - y) ** 2).item()
    return 10 * math.log10(1 / max(mse, 1e-12))
