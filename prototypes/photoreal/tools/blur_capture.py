"""A copy of a capture with motion blur, the way a phone scan has it: photos taken while the phone kept
turning are smeared along the turn by turn rate × exposure × focal length pixels, and say so in
cameras.json (turnRate), like the Atrium Capture app records it. Blurred photos come in runs (the phone
moving for a while) with one direction each, so some surfaces end up seen only smeared.

  python tools/blur_capture.py <capture-dir> <out-dir> [--fraction 0.5] [--min-px 1] [--max-px 6] [--seed 1]

Lengths are in pixels at the photos' size (the synthetic photos are 480 px across: 1-6 px there is
4-24 px on a phone's 1920 px photo). Seeds and masks are copied as they are.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image


def line_kernel(length: float, angle: float, supersample: int = 8) -> np.ndarray:
    """A normalized kernel smearing along a straight line `length` px long at `angle` radians."""
    size = int(math.ceil(length)) + 3
    size += 1 - size % 2
    k = np.zeros((size, size))
    c = size // 2
    for t in np.linspace(-length / 2, length / 2, max(2, int(length * supersample))):
        x, y = c + t * math.cos(angle), c + t * math.sin(angle)
        x0, y0 = int(math.floor(x)), int(math.floor(y))
        fx, fy = x - x0, y - y0
        for dx, dy, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            k[y0 + dy, x0 + dx] += w
    return k / k.sum()


def blur(image: np.ndarray, length: float, angle: float) -> np.ndarray:
    """The image smeared by line_kernel (edges extended)."""
    k = line_kernel(length, angle)
    r = k.shape[0] // 2
    padded = np.pad(image, ((r, r), (r, r), (0, 0)), mode="edge")
    h, w = image.shape[:2]
    out = np.zeros_like(image, dtype=np.float32)
    for dy, dx in zip(*np.nonzero(k)):
        out += k[dy, dx] * padded[dy : dy + h, dx : dx + w]
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("capture", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--fraction", type=float, default=0.5, help="share of the photos smeared")
    p.add_argument("--run", type=float, default=8.0, help="average photos in a row smeared (or sharp)")
    p.add_argument("--min-px", type=float, default=1.0)
    p.add_argument("--max-px", type=float, default=6.0)
    p.add_argument("--seed", type=int, default=1)
    a = p.parse_args()
    rng = np.random.default_rng(a.seed)

    if a.out.exists():
        shutil.rmtree(a.out)
    shutil.copytree(a.capture, a.out, ignore=shutil.ignore_patterns("frames"))
    (a.out / "frames").mkdir()
    doc = json.loads((a.capture / "cameras.json").read_text())
    frames = doc["frames"]
    # Runs of smeared and sharp photos: from a smeared run, switch with chance 1/run; from a sharp one
    # often enough that `fraction` of the photos end up smeared.
    to_sharp = 1 / a.run
    to_smeared = to_sharp * a.fraction / max(1e-6, 1 - a.fraction)
    smeared, angle, smears = rng.random() < a.fraction, rng.uniform(0, math.pi), []  # smears: px of each smeared photo
    for f in frames:
        if rng.random() < (to_sharp if smeared else to_smeared):
            smeared = not smeared
            angle = rng.uniform(0, math.pi)
        src, dst = a.capture / f["file"], a.out / f["file"]
        dst.parent.mkdir(parents=True, exist_ok=True)
        exposure = float(f.get("exposure") or 1 / 60)
        if smeared:
            length = float(rng.uniform(a.min_px, a.max_px))
            with Image.open(src) as im:
                rgb = np.asarray(im.convert("RGB"), dtype=np.float32)
            out = blur(rgb, length, angle + rng.normal(0, 0.1))
            Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8)).save(dst)
            f["turnRate"] = length / (exposure * float(f["fx"]))
            smears.append(length)
        else:
            shutil.copy2(src, dst)
        f["exposure"] = exposure
    (a.out / "cameras.json").write_text(json.dumps(doc))
    print(f"{len(smears)} of {len(frames)} photos smeared, {np.median(smears) if smears else 0:.1f} px median; written to {a.out}")


if __name__ == "__main__":
    main()
