"""A photoreal capture as the Atrium Capture app uploads it (docs/photoreal.md):

    cameras.json        every photo's camera as painted, in the walkthrough model's frame
    seeds.ply           points on the painted surfaces, in their colors (where the splats start)
    frames/<name>.jpg   the photos
    masks/<name>.png    where a photo shows people (white), for the photos that do

cameras.json poses are camera-to-world matrices in ARKit's camera convention (x right, y up,
looking along -z), column-major. Training uses OpenCV's (x right, y down, looking along +z).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

FORMAT = "atrium-photoreal/1"
# ARKit camera axes to OpenCV's: flip y and z.
ARKIT_TO_OPENCV = np.diag([1.0, -1.0, -1.0, 1.0])


@dataclass
class Camera:
    name: str
    image_path: Path
    mask_path: Path | None
    width: int
    height: int
    # Intrinsics at the photo's full size, and the pose (camera-to-world, OpenCV axes).
    K: np.ndarray
    camtoworld: np.ndarray


@dataclass
class Capture:
    cameras: list[Camera]
    seeds_xyz: np.ndarray  # (N, 3) float32
    seeds_normal: np.ndarray  # (N, 3) float32
    seeds_rgb: np.ndarray  # (N, 3) uint8
    seed_spacing: float
    bounds_min: np.ndarray
    bounds_max: np.ndarray
    rooms: list[dict]


def opencv_camtoworld(pose: list[float]) -> np.ndarray:
    """A cameras.json pose (16 numbers, column-major, ARKit camera) as an OpenCV camera-to-world matrix."""
    m = np.asarray(pose, dtype=np.float64).reshape(4, 4).T
    return m @ ARKIT_TO_OPENCV


def read_seeds(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    raw = path.read_bytes()
    marker = b"end_header\n"
    end = raw.index(marker) + len(marker)
    header = raw[:end].decode("ascii").splitlines()
    if "format binary_little_endian 1.0" not in header:
        raise ValueError("seeds.ply must be binary little-endian")
    count = int(next(line for line in header if line.startswith("element vertex")).split()[-1])
    names = [line.split()[-1] for line in header if line.startswith("property")]
    if names != ["x", "y", "z", "nx", "ny", "nz", "red", "green", "blue"]:
        raise ValueError(f"unexpected seed properties: {names}")
    record = np.dtype([("p", "<f4", 3), ("n", "<f4", 3), ("c", "u1", 3)])
    data = np.frombuffer(raw, dtype=record, count=count, offset=end)
    return data["p"].copy(), data["n"].copy(), data["c"].copy()


def load(folder: Path) -> Capture:
    folder = Path(folder)
    doc = json.loads((folder / "cameras.json").read_text())
    if doc.get("format") != FORMAT:
        raise ValueError(f"not an Atrium photoreal capture: {doc.get('format')!r}")
    cameras = []
    for f in doc["frames"]:
        name = Path(f["file"]).stem
        image = folder / f["file"]
        if not image.exists():
            continue
        mask = folder / "masks" / f"{name}.png"
        K = np.array([[f["fx"], 0, f["cx"]], [0, f["fy"], f["cy"]], [0, 0, 1]], dtype=np.float64)
        cameras.append(Camera(name, image, mask if mask.exists() else None, int(f["width"]), int(f["height"]), K, opencv_camtoworld(f["pose"])))
    if not cameras:
        raise ValueError("no photos in the capture")
    xyz, normal, rgb = read_seeds(folder / doc.get("seeds", {}).get("file", "seeds.ply"))
    bounds = doc.get("bounds") or {"min": xyz.min(0).tolist(), "max": xyz.max(0).tolist()}
    return Capture(
        cameras=cameras,
        seeds_xyz=xyz,
        seeds_normal=normal,
        seeds_rgb=rgb,
        seed_spacing=float(doc.get("seeds", {}).get("spacing", 0.03)),
        bounds_min=np.asarray(bounds["min"], dtype=np.float64),
        bounds_max=np.asarray(bounds["max"], dtype=np.float64),
        rooms=doc.get("rooms", []),
    )


def training_size(camera: Camera, long_side: int) -> tuple[int, int, float]:
    """Width, height and scale of a photo shrunk to `long_side` pixels on its long side (never enlarged)."""
    scale = min(1.0, long_side / max(camera.width, camera.height))
    return max(1, round(camera.width * scale)), max(1, round(camera.height * scale)), scale


def load_photo(camera: Camera, long_side: int) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """The photo at training size as uint8 RGB, its intrinsics there, and where it shows people
    (bool, widened by a few pixels; None if nowhere)."""
    w, h, _ = training_size(camera, long_side)
    with Image.open(camera.image_path) as im:
        rgb = np.array(im.convert("RGB").resize((w, h), Image.LANCZOS if (w, h) != im.size else Image.NEAREST))
    sx, sy = w / camera.width, h / camera.height
    K = camera.K.copy()
    K[0, 0] *= sx
    K[0, 2] *= sx
    K[1, 1] *= sy
    K[1, 2] *= sy
    people = None
    if camera.mask_path is not None:
        with Image.open(camera.mask_path) as m:
            grid = np.asarray(m.convert("L")) > 127
        if grid.any():
            # Each mask cell covers several pixels; widen by one cell so hair and edges stay out.
            from PIL import ImageFilter

            cell = math.ceil(max(w / grid.shape[1], h / grid.shape[0]))
            big = Image.fromarray((grid * 255).astype(np.uint8)).resize((w, h), Image.NEAREST)
            big = big.filter(ImageFilter.MaxFilter(2 * (cell // 2) + 1))
            people = np.asarray(big) > 127
    return rgb, K, people
