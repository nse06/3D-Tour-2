"""Trains a capture folder on this machine and writes splats.spz and stats.json: a GPU for real runs,
the CPU for tiny ones (small photos, few seeds, few steps).

    python run_local.py <capture folder> <out folder> [--steps 30000] [--long-side 1440]
                        [--max-gaussians 1000000] [--seeds N] [--holdout N] [--cpu]
"""

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from atrium_photoreal import spz
from atrium_photoreal.capture import load
from atrium_photoreal.train import TrainConfig, train


def main():
    p = argparse.ArgumentParser()
    p.add_argument("capture", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--steps", type=int, default=30_000)
    p.add_argument("--long-side", type=int, default=1440)
    p.add_argument("--max-gaussians", type=int, default=1_000_000)
    p.add_argument("--seeds", type=int, default=0, help="start from this many of the seeds (0: all)")
    p.add_argument("--holdout", type=int, default=0, help="leave every nth photo out and score it")
    p.add_argument("--cpu", action="store_true")
    a = p.parse_args()

    capture = load(a.capture)
    if a.seeds and a.seeds < len(capture.seeds_xyz):
        # Fewer seeds, spread as far apart as it takes to cover the same surfaces.
        total = len(capture.seeds_xyz)
        pick = np.random.default_rng(0).choice(total, a.seeds, replace=False)
        capture.seeds_xyz, capture.seeds_normal, capture.seeds_rgb = capture.seeds_xyz[pick], capture.seeds_normal[pick], capture.seeds_rgb[pick]
        capture.seed_spacing *= float(np.sqrt(total / len(pick)))
    cfg = TrainConfig(steps=a.steps, long_side=a.long_side, max_gaussians=a.max_gaussians, holdout_every=a.holdout, progress_every=max(1, a.steps // 20))
    device = "cpu" if a.cpu or not torch.cuda.is_available() else "cuda"
    result = train(capture, cfg, device=device, progress=lambda v, m: print(f"{v:6.1%}  {m}", flush=True))
    a.out.mkdir(parents=True, exist_ok=True)
    written = spz.write(
        a.out / "splats.spz",
        result.splats["means"].numpy(),
        result.splats["scales"].numpy(),
        result.splats["quats"].numpy(),
        result.splats["opacities"].numpy(),
        torch.cat([result.splats["sh0"], result.splats["shN"]], 1).numpy(),
        result.sh_degree,
    )
    stats = {**result.stats, **written}
    (a.out / "stats.json").write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
