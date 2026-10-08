"""Renders the held-out views from a checkpoint with the training renderer: python render_views.py ckpt.pt data out-dir"""
import json
import os
import sys

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gs  # noqa: E402

ckpt, data, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
state = torch.load(ckpt)
params, degree = state["params"], state.get("degree", 1)
tests = json.load(open(os.path.join(data, "test.json")))
bg = torch.tensor([0.81, 0.886, 0.953])
with torch.no_grad():
    for i, t in enumerate(tests):
        k = t["intrinsics"]
        cam = gs.Camera(t["transform"], k[0], k[4], k[6], k[7], t["width"], t["height"])
        img = gs.render(params, cam, degree=degree, bg=bg).clamp(0, 1)
        Image.fromarray((img.numpy() * 255 + 0.5).astype(np.uint8)).save(os.path.join(out, f"{i:02d}.png"))
print("rendered", len(tests), "views at degree", degree, "from", ckpt, "iteration", state["iter"])
