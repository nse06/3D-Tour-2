"""Puts a capture's photos next to its photoreal export, the way the app uploads them.

  python3 tools/rgb_frames.py <rgb-dir> <capture-dir>

`scanproc paint … --photoreal <capture-dir>` writes cameras.json and seeds.ply; this writes the
photos it names (frames/<name>.png) from the raw RGB files `scanproc paint` read (<rgb-dir>/<name>.rgb).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

rgb, capture = Path(sys.argv[1]), Path(sys.argv[2])
frames = json.loads((capture / "cameras.json").read_text())["frames"]
for f in frames:
    target = capture / f["file"]
    if target.exists():
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    pixels = np.frombuffer((rgb / f"{Path(f['file']).stem}.rgb").read_bytes(), dtype=np.uint8)
    Image.fromarray(pixels.reshape(int(f["height"]), int(f["width"]), 3)).save(target)
print(f"{len(frames)} photos in {capture / 'frames'}")
