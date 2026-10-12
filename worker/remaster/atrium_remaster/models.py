"""The AI models the remaster runs on a GPU (docs/remaster.md §6), loaded in the Modal containers
(modal_app.py). Each stage works without its model too (a stand-in, or the stage is skipped), so
nothing here is imported unless a container loads it. Every model here may be used commercially:

* LaMa (big-lama; code Apache-2.0, weights from its authors under the same terms), as IOPaint
  packages it (TorchScript): fills what no photo saw (fill.py).
* NAFNet (MIT; nafnet.py), its REDS deblurring weights (trained on blurred, compressed video frames,
  like the phone's photos): sharpens smeared photos (cleanup.py).
* Prompt Depth Anything (ViT-L; code and weights Apache-2.0), through transformers: sharp metric depth
  from a photo and the model's coarse depth at it (depth.py).
* SAM 2.1 (Hiera-L; Apache-2.0), through transformers: furniture cut out of the photos (furniture.py).
* TripoSG (MIT; triposg.py, on a GPU of its own): a piece of furniture's shape from its cutout.
"""

from __future__ import annotations

import math

import numpy as np

# IOPaint's TorchScript export of big-lama (github.com/Sanster/models), fetched when the image is built.
LAMA_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
LAMA_PATH = "/models/big-lama.pt"
# NAFNet's released REDS deblurring weights, as mirrored on Hugging Face (sha256 175fe8b3...4b2df3).
NAFNET_URL = "https://huggingface.co/nyanko7/nafnet-models/resolve/main/NAFNet-REDS-width64.pth"
NAFNET_PATH = "/models/NAFNet-REDS-width64.pth"


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


class NAFNetCleaner:
    """NAFNet deblurring (cleanup.Cleaner): photos in tiles of `tile` pixels overlapping by `overlap`,
    blended across the overlap, in bfloat16 on the GPU."""

    name = "NAFNet (REDS)"

    def __init__(self, path: str = NAFNET_PATH, device: str = "cuda", tile: int = 1024, overlap: int = 96):
        import torch

        from .nafnet import load

        self.torch = torch
        self.device = device
        self.tile, self.overlap = tile, overlap
        self.model = load(path, "deblur", device)

    def _run(self, x):
        torch = self.torch
        with torch.no_grad(), torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=self.device == "cuda"):
            return self.model(x).float()

    def __call__(self, images: list[np.ndarray]) -> list[np.ndarray]:
        torch = self.torch
        out = []
        for image in images:
            h, w = image.shape[:2]
            x = torch.from_numpy(image).to(self.device).permute(2, 0, 1)[None].float() / 255
            if max(h, w) <= self.tile:
                y = self._run(x)
            else:
                step = self.tile - self.overlap
                acc = torch.zeros_like(x)
                weight = torch.zeros(1, 1, h, w, device=x.device)
                ramp = torch.ones(self.tile)
                ramp[: self.overlap] = torch.linspace(0.05, 1, self.overlap)
                ramp[-self.overlap :] = torch.linspace(1, 0.05, self.overlap)
                for y0 in list(range(0, max(1, h - self.overlap), step)):
                    for x0 in list(range(0, max(1, w - self.overlap), step)):
                        y0c, x0c = min(y0, max(0, h - self.tile)), min(x0, max(0, w - self.tile))
                        y1c, x1c = min(h, y0c + self.tile), min(w, x0c + self.tile)
                        piece = self._run(x[:, :, y0c:y1c, x0c:x1c])
                        wy = ramp[: y1c - y0c].to(x.device) if y1c - y0c == self.tile else torch.ones(y1c - y0c, device=x.device)
                        wx = ramp[: x1c - x0c].to(x.device) if x1c - x0c == self.tile else torch.ones(x1c - x0c, device=x.device)
                        wgt = (wy[:, None] * wx[None, :])[None, None]
                        acc[:, :, y0c:y1c, x0c:x1c] += piece * wgt
                        weight[:, :, y0c:y1c, x0c:x1c] += wgt
                y = acc / weight.clamp(min=1e-6)
            out.append((y[0].permute(1, 2, 0).clamp(0, 1) * 255 + 0.5).byte().cpu().numpy())
        return out


PROMPT_DEPTH = "depth-anything/prompt-depth-anything-vitl-hf"


class PromptDepth:
    """Prompt Depth Anything (depth.DepthModel): the prompt in millimeters, as its processor expects
    (ARKit's depth maps), the answer in meters at each photo's size."""

    name = "Prompt Depth Anything (ViT-L)"

    def __init__(self, name: str = PROMPT_DEPTH, device: str = "cuda"):
        import torch
        from transformers import AutoImageProcessor, PromptDepthAnythingForDepthEstimation

        self.torch = torch
        self.device = device
        self.processor = AutoImageProcessor.from_pretrained(name)
        self.model = PromptDepthAnythingForDepthEstimation.from_pretrained(name).to(device).eval()

    def __call__(self, images: list[np.ndarray], prompts: list[np.ndarray]) -> list[np.ndarray]:
        from PIL import Image

        out = []
        for image, prompt in zip(images, prompts):
            inputs = self.processor(images=Image.fromarray(image), return_tensors="pt", prompt_depth=prompt.astype(np.float32) * 1000.0)
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            with self.torch.no_grad():
                result = self.model(**inputs)
            depth = self.processor.post_process_depth_estimation(result, target_sizes=[image.shape[:2]])[0]["predicted_depth"]
            out.append(depth.float().cpu().numpy())
        return out


SAM2 = "facebook/sam2.1-hiera-large"


class Sam2Segmenter:
    """SAM 2.1 (Hiera-L; code and weights Apache-2.0), through transformers: pieces of furniture cut out
    of a photo, each box a prompt (furniture.Segmenter)."""

    name = "SAM 2.1"

    def __init__(self, name: str = SAM2, device: str = "cuda"):
        import torch
        from transformers import Sam2Model, Sam2Processor

        self.torch = torch
        self.device = device
        self.processor = Sam2Processor.from_pretrained(name)
        self.model = Sam2Model.from_pretrained(name).to(device).eval()

    def __call__(self, image: np.ndarray, boxes: list[tuple[float, float, float, float]]) -> list[np.ndarray]:
        from PIL import Image

        if not boxes:
            return []
        inputs = self.processor(images=Image.fromarray(np.asarray(image, np.uint8)), input_boxes=[[[float(v) for v in b] for b in boxes]], return_tensors="pt")
        sizes = inputs["original_sizes"]
        with self.torch.no_grad():
            out = self.model(**inputs.to(self.device), multimask_output=False)
        masks = self.processor.post_process_masks(out.pred_masks.cpu(), sizes)[0]  # (boxes, 1, H, W)
        return [m[0].numpy().astype(bool) for m in masks]


def png(image: np.ndarray) -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.fromarray(np.asarray(image, np.uint8)).save(out, "PNG")
    return out.getvalue()


def unpng(data: bytes) -> np.ndarray:
    import io

    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:
        return np.asarray(im.convert("RGB"))


def pack_shape(vertices: np.ndarray, faces: np.ndarray) -> bytes:
    import io

    out = io.BytesIO()
    np.savez_compressed(out, vertices=np.asarray(vertices, np.float32), faces=np.asarray(faces, np.int32))
    return out.getvalue()


def unpack_shape(data: bytes) -> tuple[np.ndarray, np.ndarray]:
    import io

    with np.load(io.BytesIO(data)) as z:
        return z["vertices"], z["faces"].astype(np.int64)


class RemoteShapes:
    """The shape maker on its own GPU (modal_app.Shapes): cutouts go as PNGs, shapes come back packed."""

    name = "TripoSG (remote)"

    def __init__(self, remote):
        self.remote = remote

    def __call__(self, images: list[np.ndarray]) -> list[tuple[np.ndarray, np.ndarray] | None]:
        if not images:
            return []
        answers = self.remote.make.remote([png(image) for image in images])
        return [None if a is None else unpack_shape(a) for a in answers]
