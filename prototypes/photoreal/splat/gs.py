"""3D Gaussian splatting on the CPU: projection and shading in PyTorch, rasterization in C++ (rasterize.cpp)."""
import math
import os

import torch
from torch.utils.cpp_extension import load

HERE = os.path.dirname(os.path.abspath(__file__))
_ext = load(name="gsrast", sources=[os.path.join(HERE, "rasterize.cpp")], extra_cflags=["-O3", "-fopenmp", "-march=native", "-ffast-math"],
            extra_ldflags=["-fopenmp"], build_directory=os.path.join(HERE, "build"), verbose=False) if os.makedirs(os.path.join(HERE, "build"), exist_ok=True) is None else None

C0 = 0.28209479177387814
C1 = 0.4886025119029199


class Rasterize(torch.autograd.Function):
    @staticmethod
    def forward(ctx, means2d, conics, colors, opacities, depths, radii, w, h, bg):
        image, final_t, contrib, lst, ranges = _ext.forward(means2d, conics, colors, opacities, depths, radii, w, h, bg)
        ctx.save_for_backward(means2d, conics, colors, opacities, final_t, contrib, lst, ranges, bg)
        ctx.size = (w, h)
        return image

    @staticmethod
    def backward(ctx, grad_image):
        means2d, conics, colors, opacities, final_t, contrib, lst, ranges, bg = ctx.saved_tensors
        w, h = ctx.size
        gm, gc, gcol, gop = _ext.backward(means2d, conics, colors, opacities, final_t, contrib, lst, ranges, w, h, bg, grad_image.contiguous())
        return gm, gc, gcol, gop, None, None, None, None, None


def quat_to_rot(q):
    q = q / q.norm(dim=1, keepdim=True)
    w, x, y, z = q.unbind(1)
    return torch.stack([
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ], dim=1).reshape(-1, 3, 3)


class Camera:
    """From an ARKit camera-to-world (16 floats, column-major, −Z forward) and pinhole intrinsics."""

    def __init__(self, transform, fx, fy, cx, cy, w, h):
        m = torch.tensor(transform, dtype=torch.float32).reshape(4, 4).T  # row-major 4×4
        r, c = m[:3, :3], m[:3, 3]
        d = torch.diag(torch.tensor([1.0, -1.0, -1.0]))
        self.R = d @ r.T  # world → OpenCV camera (x right, y down, z forward)
        self.t = -self.R @ c
        self.center = c
        self.fx, self.fy, self.cx, self.cy, self.w, self.h = fx, fy, cx, cy, w, h


def sh_colors(sh, dirs, degree):
    """sh: (N, K, 3) coefficients; dirs: unit (N, 3) from the camera to each Gaussian."""
    out = C0 * sh[:, 0]
    if degree > 0:
        x, y, z = dirs[:, 0:1], dirs[:, 1:2], dirs[:, 2:3]
        out = out - C1 * y * sh[:, 1] + C1 * z * sh[:, 2] - C1 * x * sh[:, 3]
    return (out + 0.5).clamp_min(0.0)


def render(g, cam, degree=1, bg=None, return_info=False, radius_sigma=3.0):
    """g: dict of parameters (means, log_scales, quats, opacity_logits, sh). Returns (H, W, 3) image."""
    means = g["means"]
    with torch.no_grad():
        p = means @ cam.R.T + cam.t
        z = p[:, 2]
        tx, ty = 1.3 * (cam.w / 2) / cam.fx, 1.3 * (cam.h / 2) / cam.fy
        vis = (z > 0.1) & (p[:, 0].abs() < tx * z + 0.5) & (p[:, 1].abs() < ty * z + 0.5)
        idx = vis.nonzero().squeeze(1)
    m = means[idx]
    pc = m @ cam.R.T + cam.t
    z = pc[:, 2]
    x = (pc[:, 0] / z).clamp(-1.3 * cam.w / 2 / cam.fx, 1.3 * cam.w / 2 / cam.fx) * z
    y = (pc[:, 1] / z).clamp(-1.3 * cam.h / 2 / cam.fy, 1.3 * cam.h / 2 / cam.fy) * z
    means2d = torch.stack([cam.fx * pc[:, 0] / z + cam.cx, cam.fy * pc[:, 1] / z + cam.cy], dim=1)
    # 3D covariance and its projection (EWA splatting).
    rot = quat_to_rot(g["quats"][idx])
    scales = g["log_scales"][idx].exp()
    mm = rot * scales[:, None, :]
    cov3 = mm @ mm.transpose(1, 2)
    zero = torch.zeros_like(z)
    J = torch.stack([cam.fx / z, zero, -cam.fx * x / (z * z), zero, cam.fy / z, -cam.fy * y / (z * z)], dim=1).reshape(-1, 2, 3)
    T = J @ cam.R
    cov2 = T @ cov3 @ T.transpose(1, 2)
    a = cov2[:, 0, 0] + 0.3
    b = cov2[:, 0, 1]
    c = cov2[:, 1, 1] + 0.3
    det = (a * c - b * b).clamp_min(1e-12)
    conics = torch.stack([c / det, -b / det, a / det], dim=1)
    with torch.no_grad():
        mid = 0.5 * (a + c)
        lam = mid + (mid * mid - det).clamp_min(0.1).sqrt()
        radii = (radius_sigma * lam.sqrt()).ceil().to(torch.int32)
        on = (means2d[:, 0] + radii > 0) & (means2d[:, 0] - radii < cam.w) & (means2d[:, 1] + radii > 0) & (means2d[:, 1] - radii < cam.h)
        radii = torch.where(on, radii, torch.zeros_like(radii))
    dirs = m - cam.center
    dirs = dirs / dirs.norm(dim=1, keepdim=True)
    colors = sh_colors(g["sh"][idx], dirs, degree)
    opac = torch.sigmoid(g["opacity_logits"][idx]).squeeze(1)
    if bg is None:
        bg = torch.zeros(3)
    if means2d.requires_grad:
        means2d.retain_grad()
    image = Rasterize.apply(means2d, conics.contiguous(), colors.contiguous(), opac.contiguous(), z.detach().contiguous(), radii, cam.w, cam.h, bg)
    if return_info:
        return image, {"idx": idx, "means2d": means2d, "radii": radii}
    return image
