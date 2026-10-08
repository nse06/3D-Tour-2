"""Checks the rasterizer's hand-written gradients against finite differences.

The renderer skips Gaussians fainter than 1/255 (as the reference implementation does), which makes
the image jump by tiny amounts as Gaussians move; the check therefore builds a variant without that
cutoff, where analytic and numeric gradients agree to about 3 digits.

  python splat/gradcheck.py
"""
import os

import torch
from torch.utils.cpp_extension import load

import gs

here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, "build-smooth"), exist_ok=True)
gs._ext = load(name="gsrast_smooth", sources=[os.path.join(here, "rasterize.cpp")], extra_cflags=["-O2", "-fopenmp", "-DGS_ALPHA_MIN=0.0f"],
               extra_ldflags=["-fopenmp"], build_directory=os.path.join(here, "build-smooth"))
torch.manual_seed(0)
n = 60
g = {
    "means": (torch.rand(n, 3) * torch.tensor([2.0, 1.5, 1.0]) + torch.tensor([-1.0, -0.75, 2.0])).requires_grad_(),
    "log_scales": (torch.rand(n, 3) * 0.6 - 2.6).requires_grad_(),
    "quats": torch.randn(n, 4).requires_grad_(),
    "opacity_logits": (torch.randn(n, 1) * 0.5).requires_grad_(),
    "sh": (torch.randn(n, 4, 3) * 0.4).requires_grad_(),
}
cam = gs.Camera([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1], 60.0, 60.0, 32.0, 24.0, 64, 48)  # looks along +z
target = torch.rand(48, 64, 3)
bg = torch.tensor([0.2, 0.3, 0.4])


def loss():
    return ((gs.render(g, cam, degree=1, bg=bg).double() - target.double()) ** 2).sum()


loss().backward()
for name, p in g.items():
    worst = 0.0
    for _ in range(12):
        i = tuple(torch.randint(0, s, (1,)).item() for s in p.shape)
        with torch.no_grad():
            old = p[i].item()
            p[i] = old + 1e-3
            lp = loss().item()
            p[i] = old - 1e-3
            lm = loss().item()
            p[i] = old
        fd, an = (lp - lm) / 2e-3, p.grad[i].item()
        if abs(fd) > 1e-3 or abs(an) > 1e-3:
            worst = max(worst, abs(fd - an) / max(abs(fd), abs(an)))
    print(f"{name:15s} worst relative error {worst:.4f}")
