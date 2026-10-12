"""The AI models the remaster runs on a GPU (docs/remaster.md §6), loaded in the Modal containers
(modal_app.py). Each stage works without its model too (a stand-in, or the stage is skipped), so
nothing here is imported unless a container loads it. Every model here may be used commercially:

* LaMa (big-lama; code Apache-2.0, weights from its authors under the same terms), as IOPaint
  packages it (TorchScript): fills what no photo saw (fill.py).
"""

from __future__ import annotations

import math

import numpy as np

# IOPaint's TorchScript export of big-lama (github.com/Sanster/models), fetched when the image is built.
LAMA_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
LAMA_PATH = "/models/big-lama.pt"


class LaMa:
    """LaMa inpainting (fill.Inpainter): images and masks of any size; above `max_side` pixels the
    image is filled at that size and the filled part scaled back up (what's filled is broad anyway)."""

    name = "LaMa"

    def __init__(self, path: str = LAMA_PATH, device: str = "cuda", max_side: int = 2048):
        import torch

        self.torch = torch
        self.device = device
        self.max_side = max_side
        self.model = torch.jit.load(path, map_location=device).eval()

    def _fill(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        torch = self.torch
        h, w = mask.shape
        ph, pw = -h % 8, -w % 8  # LaMa works on sides divisible by 8
        img = np.pad(image, ((0, ph), (0, pw), (0, 0)), mode="reflect") if (ph or pw) else image
        msk = np.pad(mask, ((0, ph), (0, pw)), mode="reflect") if (ph or pw) else mask
        x = torch.from_numpy(img).permute(2, 0, 1)[None].float().div(255).to(self.device)
        m = torch.from_numpy(msk.astype(np.float32))[None, None].to(self.device)
        with torch.no_grad():
            y = self.model(x, m)
        out = (y[0].permute(1, 2, 0).clamp(0, 1) * 255 + 0.5).byte().cpu().numpy()
        return out[:h, :w]

    def __call__(self, images: list[np.ndarray], masks: list[np.ndarray]) -> list[np.ndarray]:
        from PIL import Image

        out = []
        for image, mask in zip(images, masks):
            h, w = mask.shape
            scale = min(1.0, self.max_side / max(h, w))
            if scale < 1:
                sw, sh = max(8, int(math.ceil(w * scale))), max(8, int(math.ceil(h * scale)))
                small = np.asarray(Image.fromarray(image).resize((sw, sh), Image.LANCZOS))
                small_mask = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize((sw, sh), Image.NEAREST)) > 127
                filled = np.asarray(Image.fromarray(self._fill(small, small_mask)).resize((w, h), Image.BICUBIC))
            else:
                filled = self._fill(image, mask)
            out.append(np.where(mask[..., None], filled, image).astype(np.uint8))
        return out
