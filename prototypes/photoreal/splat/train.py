"""Trains 3D Gaussian splats on the synthetic capture (CPU).

  python train.py <data-dir> <out-dir> [--iters N] [--gaussians N] [--max-gaussians N]

Seeds from LiDAR-like points on the surfaces (as a phone scan would give), colored from the photos;
L1 + 0.2 D-SSIM; adaptive density control (clone/split/prune) and opacity resets as in Kerbl et
al. 2023; half resolution for the first 30% of the iterations. Writes checkpoints, a .ply and a log.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gs  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("data")
p.add_argument("out")
p.add_argument("--iters", type=int, default=8000)
p.add_argument("--gaussians", type=int, default=450_000)
p.add_argument("--max-gaussians", type=int, default=800_000)
p.add_argument("--degree", type=int, default=1)
p.add_argument("--coarse", type=float, default=0.3, help="share of iterations at half resolution")
p.add_argument("--resume", default=None)
args = p.parse_args()
torch.manual_seed(0)
np.random.seed(0)
torch.set_num_threads(os.cpu_count() or 4)
os.makedirs(args.out, exist_ok=True)
log = open(os.path.join(args.out, "train.log"), "a")


def say(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    log.write(s + "\n")
    log.flush()


# ---------- data ----------
frames = json.load(open(os.path.join(args.data, "frames.json")))
tests = json.load(open(os.path.join(args.data, "test.json")))


def load_image(path):
    return torch.from_numpy(np.asarray(Image.open(path).convert("RGB"))).contiguous()  # uint8 (H, W, 3)


train_imgs = [load_image(os.path.join(args.data, f["file"])) for f in frames]
test_imgs = [load_image(os.path.join(args.data, t["file"])) for t in tests]


def camera(f, scale=1.0):
    k = f["intrinsics"]
    return gs.Camera(f["transform"], k[0] * scale, k[4] * scale, k[6] * scale, k[7] * scale, int(f["width"] * scale), int(f["height"] * scale))


cams_full = [camera(f) for f in frames]
cams_half = [camera(f, 0.5) for f in frames]
test_cams = [camera(t) for t in tests]
centers = torch.stack([c.center for c in cams_full])
extent = float((centers - centers.mean(0)).norm(dim=1).max()) * 1.1
say(f"{len(frames)} training views, {len(tests)} test views, extent {extent:.2f} m")
BG = torch.tensor([0.81, 0.886, 0.953])


def half(img):
    x = img.permute(2, 0, 1).float()[None] / 255.0
    return F.avg_pool2d(x, 2)[0].permute(1, 2, 0)


# ---------- initialization ----------
def quat_from_z(n):
    """Rotations taking +z to each unit normal (w, x, y, z)."""
    z = torch.tensor([0.0, 0.0, 1.0]).expand_as(n)
    axis = torch.cross(z, n, dim=1)
    w = 1.0 + (n * z).sum(1, keepdim=True)
    q = torch.cat([w, axis], dim=1)
    flip = w.squeeze(1) < 1e-6
    q[flip] = torch.tensor([0.0, 1.0, 0.0, 0.0])
    return q / q.norm(dim=1, keepdim=True)


def init_gaussians():
    d = np.load(os.path.join(args.data, "points.npz"))
    pts, nrm, kinds = torch.from_numpy(d["points"]), torch.from_numpy(d["normals"]), torch.from_numpy(d["kinds"].astype(np.int64))
    outside = kinds == 5
    keep_out = outside.nonzero().squeeze(1)
    inside = (~outside).nonzero().squeeze(1)
    n_in = min(len(inside), args.gaussians - len(keep_out))
    inside = inside[torch.randperm(len(inside))[:n_in]]
    sel = torch.cat([inside, keep_out])
    pts, nrm, outside = pts[sel], nrm[sel], outside[sel]
    # Spacing: about 600 m² of indoor surface for n_in points; the views outside are sparse.
    spacing_in = math.sqrt(600.0 / max(n_in, 1))
    s = torch.where(outside, torch.full((len(pts),), 0.06), torch.full((len(pts),), spacing_in * 0.7))
    scales = torch.stack([s, s, s * 0.25], dim=1)
    # Colors: median of the photos' pixels where each point projects (several photos, no occlusion test).
    colors = torch.zeros(len(pts), 3)
    samples = [[] for _ in range(3)]
    count = torch.zeros(len(pts))
    acc = torch.zeros(len(pts), 3)
    for k in torch.randperm(len(frames))[:120].tolist():
        c = cams_full[k]
        pc = pts @ c.R.T + c.t
        z = pc[:, 2]
        u = c.fx * pc[:, 0] / z + c.cx
        v = c.fy * pc[:, 1] / z + c.cy
        ok = (z > 0.2) & (z < 6) & (u >= 0) & (u < c.w - 1) & (v >= 0) & (v < c.h - 1)
        # Facing the camera.
        ok &= ((c.center - pts) * nrm).sum(1) > 0
        idx = ok.nonzero().squeeze(1)
        px = train_imgs[k][v[idx].long(), u[idx].long()].float() / 255.0
        acc[idx] += px
        count[idx] += 1
    seen = count > 0
    colors[seen] = acc[seen] / count[seen, None]
    colors[~seen] = 0.6
    say(f"seeded {len(pts)} Gaussians ({int(outside.sum())} outside), colored {int(seen.sum())} from photos, spacing {spacing_in * 100:.1f} cm")
    sh = torch.zeros(len(pts), (args.degree + 1) ** 2, 3)
    sh[:, 0] = (colors - 0.5) / gs.C0
    return {
        "means": pts.clone(),
        "log_scales": scales.log(),
        "quats": quat_from_z(nrm),
        "opacity_logits": torch.logit(torch.full((len(pts), 1), 0.3)),
        "sh": sh,
    }


# ---------- optimizer (Adam whose state follows densification) ----------
class Adam:
    def __init__(self, params, lrs):
        self.p = {k: v.detach().clone().requires_grad_() for k, v in params.items()}
        self.m = {k: torch.zeros_like(v) for k, v in self.p.items()}
        self.v = {k: torch.zeros_like(v) for k, v in self.p.items()}
        self.lrs = lrs
        self.t = 0

    def step(self, lr_scale):
        self.t += 1
        b1, b2, eps = 0.9, 0.999, 1e-15
        with torch.no_grad():
            for k, p in self.p.items():
                if p.grad is None:
                    continue
                g = p.grad
                self.m[k].mul_(b1).add_(g, alpha=1 - b1)
                self.v[k].mul_(b2).addcmul_(g, g, value=1 - b2)
                lr = self.lrs[k] * lr_scale.get(k, 1.0)
                mh = self.m[k] / (1 - b1 ** self.t)
                vh = self.v[k] / (1 - b2 ** self.t)
                if k == "sh":
                    # The view-dependent terms learn 20× slower than the base color.
                    lr_t = torch.full((p.shape[1], 1), lr / 20.0)
                    lr_t[0] = lr
                    p.sub_(lr_t * mh / (vh.sqrt() + eps))
                else:
                    p.sub_(lr * mh / (vh.sqrt() + eps))
                p.grad = None

    def keep(self, mask):
        for d in (self.m, self.v):
            for k in d:
                d[k] = d[k][mask]
        for k in self.p:
            self.p[k] = self.p[k].detach()[mask].clone().requires_grad_()

    def append(self, new):
        for k in self.p:
            self.p[k] = torch.cat([self.p[k].detach(), new[k]]).requires_grad_()
            self.m[k] = torch.cat([self.m[k], torch.zeros_like(new[k])])
            self.v[k] = torch.cat([self.v[k], torch.zeros_like(new[k])])


# ---------- SSIM ----------
_win = None


def ssim(a, b):
    global _win
    if _win is None:
        x = torch.arange(11, dtype=torch.float32) - 5
        g = torch.exp(-(x * x) / (2 * 1.5 * 1.5))
        g = g / g.sum()
        _win = (g[:, None] * g[None, :]).expand(3, 1, 11, 11).contiguous()
    a = a.permute(2, 0, 1)[None]
    b = b.permute(2, 0, 1)[None]
    mu_a = F.conv2d(a, _win, padding=5, groups=3)
    mu_b = F.conv2d(b, _win, padding=5, groups=3)
    s_aa = F.conv2d(a * a, _win, padding=5, groups=3) - mu_a * mu_a
    s_bb = F.conv2d(b * b, _win, padding=5, groups=3) - mu_b * mu_b
    s_ab = F.conv2d(a * b, _win, padding=5, groups=3) - mu_a * mu_b
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    m = ((2 * mu_a * mu_b + c1) * (2 * s_ab + c2)) / ((mu_a * mu_a + mu_b * mu_b + c1) * (s_aa + s_bb + c2))
    return m.mean()


def psnr(a, b):
    mse = ((a - b) ** 2).mean().item()
    return 10 * math.log10(1.0 / max(mse, 1e-10))


# ---------- training ----------
if args.resume:
    state = torch.load(args.resume)
    params, start = state["params"], state["iter"]
else:
    params, start = init_gaussians(), 0
lrs = {"means": 0.00016 * extent, "log_scales": 0.005, "quats": 0.001, "opacity_logits": 0.05, "sh": 0.0025}
opt = Adam(params, lrs)
n = opt.p["means"].shape[0]
grad_acc = torch.zeros(n)
grad_cnt = torch.zeros(n)
max_radius = torch.zeros(n)
densify_until = int(args.iters * 0.5)
order = []
t0 = time.time()


def evaluate(degree):
    with torch.no_grad():
        vals = []
        for c, img in zip(test_cams, test_imgs):
            out = gs.render(opt.p, c, degree=degree, bg=BG).clamp(0, 1)
            vals.append(psnr(out, img.float() / 255.0))
    return sum(vals) / len(vals)


def densify(it):
    global grad_acc, grad_cnt, max_radius
    with torch.no_grad():
        p = opt.p
        avg = grad_acc / grad_cnt.clamp_min(1)
        scales = p["log_scales"].exp().max(dim=1).values
        big = scales > 0.01 * extent
        sel = (avg > 0.0002) & (grad_cnt > 0)
        room = args.max_gaussians - p["means"].shape[0]
        if room <= 0:
            sel[:] = False
        elif sel.sum() > room:
            thresh = avg[sel].topk(room).values.min()
            sel &= avg >= thresh
        clone = sel & ~big
        split = sel & big
        new = {k: v.detach()[clone].clone() for k, v in p.items()}
        # Split: two samples inside each big Gaussian, 1.6× smaller.
        si = split.nonzero().squeeze(1)
        if len(si):
            rot = gs.quat_to_rot(p["quats"][si])
            sc = p["log_scales"][si].exp()
            for _ in range(2):
                offs = (rot @ (torch.randn(len(si), 3) * sc)[..., None]).squeeze(-1)
                part = {k: v.detach()[si].clone() for k, v in p.items()}
                part["means"] = part["means"] + offs
                part["log_scales"] = (sc / 1.6).log()
                for k in new:
                    new[k] = torch.cat([new[k], part[k]])
        opt.append(new)
        n_new = new["means"].shape[0]
        # Remove the split originals, transparent and oversized Gaussians.
        n_all = opt.p["means"].shape[0]
        keep = torch.ones(n_all, dtype=torch.bool)
        keep[si] = False
        op = torch.sigmoid(opt.p["opacity_logits"]).squeeze(1)
        keep &= op > 0.005
        sc_all = opt.p["log_scales"].exp().max(dim=1).values
        keep &= sc_all < 0.15 * extent
        if it > 3000:
            mr = torch.cat([max_radius, torch.zeros(n_new)])
            keep &= mr < 40
        opt.keep(keep)
        n_now = opt.p["means"].shape[0]
        grad_acc = torch.zeros(n_now)
        grad_cnt = torch.zeros(n_now)
        max_radius = torch.zeros(n_now)
        return int(clone.sum()), len(si), n_all - int(keep.sum()), n_now


for it in range(start, args.iters):
    coarse = it < args.iters * args.coarse
    if not order:
        order = torch.randperm(len(frames)).tolist()
    k = order.pop()
    cam = cams_half[k] if coarse else cams_full[k]
    gt = half(train_imgs[k]) if coarse else train_imgs[k].float() / 255.0
    degree = 0 if it < 1000 else args.degree
    frac = it / max(1, args.iters)
    lr_scale = {"means": math.exp(math.log(0.01) * frac)}
    out, info = gs.render(opt.p, cam, degree=degree, bg=BG, return_info=True)
    loss = 0.8 * (out - gt).abs().mean() + 0.2 * (1 - ssim(out, gt))
    loss.backward()
    with torch.no_grad():
        idx, m2d, radii = info["idx"], info["means2d"], info["radii"]
        if m2d.grad is not None and it < densify_until:
            seen = radii > 0
            gnorm = (m2d.grad * torch.tensor([cam.w / 2.0, cam.h / 2.0])).norm(dim=1)
            grad_acc[idx[seen]] += gnorm[seen]
            grad_cnt[idx[seen]] += 1
            max_radius[idx[seen]] = torch.maximum(max_radius[idx[seen]], radii[seen].float() * (2 if coarse else 1))
    opt.step(lr_scale)
    if it >= 500 and it < densify_until and it % 100 == 0:
        c, s, pr, n_now = densify(it)
        say(f"  densify @{it}: +{c} clones, {s} splits, -{pr} pruned → {n_now}")
    if it > 0 and it % 3000 == 0 and it < densify_until:
        with torch.no_grad():
            opt.p["opacity_logits"].copy_(torch.logit(torch.sigmoid(opt.p["opacity_logits"]).clamp(max=0.01)))
            opt.m["opacity_logits"].zero_()
            opt.v["opacity_logits"].zero_()
        say(f"  opacity reset @{it}")
    if it % 50 == 0:
        el = time.time() - t0
        say(f"it {it} loss {loss.item():.4f} psnr {psnr(out.detach().clamp(0, 1), gt):.2f} n {opt.p['means'].shape[0]} vis {len(idx)} {'half' if coarse else 'full'} {el:.0f}s ({el / max(1, it - start + 1):.2f} s/it)")
    if it % 1000 == 999 or it == args.iters - 1:
        say(f"  test PSNR @{it + 1}: {evaluate(degree):.2f}")
        torch.save({"params": {k: v.detach() for k, v in opt.p.items()}, "iter": it + 1, "degree": degree}, os.path.join(args.out, "ckpt.pt"))
say("done")
