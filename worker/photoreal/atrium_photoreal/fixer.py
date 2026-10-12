"""NVIDIA Fixer on a GPU: cleans up renders of the splats for the AI-enhanced version (enhance.py).

Fixer (https://huggingface.co/nvidia/Fixer, code https://github.com/nv-tlabs/Fixer) is NVIDIA's
commercially licensed successor of Difix3D+: Cosmos-Predict2's 0.6B image model, trained to turn a
render of a 3D reconstruction into a clean picture in one denoising step. Its weights are under the
NVIDIA Open Model License (commercial use allowed), its code under Apache 2.0. It runs in
the image remote.py describes: Cosmos-Predict2 with NVIDIA's prebuilt CUDA wheels, the Fixer repository
at /opt/fixer and its weights at /work/models, where Fixer's code looks for them.
"""

from __future__ import annotations

import sys

import numpy as np
from PIL import Image

SRC = "/opt/fixer/src"
WEIGHTS = "/work/models/pretrained/pretrained_fixer.pkl"
# Fixer's noise level for its one step (its README's inference command), and the size it was trained
# at (width, height): views come rendered at this size (EnhanceConfig).
TIMESTEP = 250
SIZE = (1024, 576)


class FixerModel:
    name = "nvidia/Fixer"

    def __init__(self, batch: int = 4):
        import torch

        if SRC not in sys.path:
            sys.path.insert(0, SRC)
        import transformer_engine  # noqa: F401  (Fixer's own inference script loads it first)
        from pix2pix_turbo_nocond_cosmos_base_faster_tokenizer import Pix2Pix_Turbo

        self.torch = torch
        # The model is built for a fixed batch size: smaller batches are padded.
        self.batch = batch
        self.model = Pix2Pix_Turbo(pretrained_path=WEIGHTS, timestep=TIMESTEP, batch_size=batch).to(device="cuda", dtype=torch.bfloat16)
        self.model.set_eval()

    def _tensor(self, image: np.ndarray):
        if (image.shape[1], image.shape[0]) != SIZE:
            image = np.asarray(Image.fromarray(image).resize(SIZE, Image.BILINEAR))
        x = self.torch.from_numpy(np.array(image, dtype=np.uint8)).permute(2, 0, 1).float() / 255.0
        return x * 2 - 1

    def __call__(self, images: list[np.ndarray]) -> list[np.ndarray]:
        torch = self.torch
        out: list[np.ndarray] = []
        for k in range(0, len(images), self.batch):
            chunk = images[k : k + self.batch]
            x = torch.stack([self._tensor(im) for im in chunk] + [torch.zeros(3, SIZE[1], SIZE[0])] * (self.batch - len(chunk)))
            with torch.no_grad(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                y = self.model(x.to(device="cuda", dtype=torch.bfloat16))
            y = ((y.float() * 0.5 + 0.5).clamp(0, 1) * 255).round().byte().permute(0, 2, 3, 1).cpu().numpy()
            for image, fixed in zip(chunk, y):
                if fixed.shape[:2] != image.shape[:2]:
                    fixed = np.asarray(Image.fromarray(fixed).resize((image.shape[1], image.shape[0]), Image.BILINEAR))
                out.append(fixed)
        return out


def fix_jpegs(model: FixerModel, jpegs: list[bytes]) -> list[bytes]:
    """What a Modal Fixer's fix() does (remote.py): JPEGs in, cleaned JPEGs out."""
    from .enhance import from_jpeg, to_jpeg

    return [to_jpeg(image) for image in model([from_jpeg(data) for data in jpegs])]
