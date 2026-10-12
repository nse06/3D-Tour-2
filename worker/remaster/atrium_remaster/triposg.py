"""TripoSG (VAST-AI; code and weights MIT): a piece of furniture's shape from its cutout
(furniture.ShapeMaker), on a GPU of its own (modal_app.Shapes, its own image).

Only its marching-cubes decoder is used (scikit-image): its fast decoder needs diso, whose license the
remaster doesn't take on, so the image puts a stub in its place for TripoSG's imports. Its background
remover (RMBG-1.4, non-commercial) isn't used either: the cutouts come from SAM 2.1 (furniture.py).
"""

from __future__ import annotations

import traceback

import numpy as np

TRIPOSG_REPO = "https://github.com/VAST-AI-Research/TripoSG"
TRIPOSG_COMMIT = "fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c"
TRIPOSG_WEIGHTS = "VAST-AI/TripoSG"
TRIPOSG_REVISION = "2c1c516d22d58db486a058d98d31bb6177344e06"
TRIPOSG_PATH = "/models/TripoSG"


class TripoSG:
    """Shapes from cutouts on white, y up, about 2 units across (furniture.fit turns and stretches them)."""

    name = "TripoSG"

    def __init__(self, path: str = TRIPOSG_PATH, device: str = "cuda", steps: int = 50, guidance: float = 7.0, seed: int = 0):
        import torch
        from triposg.pipelines.pipeline_triposg import TripoSGPipeline

        self.torch = torch
        self.device = device
        self.steps, self.guidance, self.seed = steps, guidance, seed
        self.pipe = TripoSGPipeline.from_pretrained(path).to(device, torch.float16)

    def __call__(self, images: list[np.ndarray]) -> list[tuple[np.ndarray, np.ndarray] | None]:
        from PIL import Image

        out: list[tuple[np.ndarray, np.ndarray] | None] = []
        for image in images:
            try:
                with self.torch.no_grad():
                    vertices, faces = self.pipe(
                        image=Image.fromarray(np.asarray(image, np.uint8)),
                        generator=self.torch.Generator(device=self.device).manual_seed(self.seed),
                        num_inference_steps=self.steps,
                        guidance_scale=self.guidance,
                        use_flash_decoder=False,
                    ).samples[0]
                out.append(None if vertices is None else (np.asarray(vertices, np.float32), np.asarray(faces, np.int64)))
            except Exception:  # that piece keeps its scanned shape
                traceback.print_exc()
                out.append(None)
        return out
