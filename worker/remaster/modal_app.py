"""Atrium's remaster worker on Modal (https://modal.com), separate from the photoreal one
(worker/photoreal): a GPU function that rebuilds one photo scan's painted model (atrium_remaster), and
a web endpoint the Atrium site calls to start it (REMASTER_GPU_URL on the site). It shares the
photoreal worker's secret. NVIDIA's Fixer runs on a GPU of its own (the photoreal worker's image), and so
does TripoSG, which makes the furniture's shapes (an image of its own).

Setup (once; see docs/remaster.md):

    pip install modal fastapi && modal setup  # or MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in the environment
    # the secret is the photoreal worker's: modal secret create atrium-photoreal PHOTOREAL_WORKER_SECRET=...
    cd worker/remaster && modal deploy modal_app.py

The deploy prints the endpoint's URL (https://<workspace>--atrium-remaster-start.modal.run): set it as
REMASTER_GPU_URL on the site.

On a capture folder and its painted model, without the site (writes <out>/remastered.glb and
<out>/stats.json):

    modal run modal_app.py::remaster_folder --capture <capture folder> --model <painted .glb> --out <folder>
"""

import hmac
import os
import re
import sys
from pathlib import Path

import modal
from fastapi import Header, HTTPException

# Deployed from the repository, this worker's package sits here and the photoreal worker's next door
# (worker/photoreal); in the containers both are in place already.
_here = Path(__file__).resolve().parent
for _folder, _package in ((_here.parent / "photoreal", "atrium_photoreal"), (_here, "atrium_remaster")):
    if (_folder / _package).is_dir() and str(_folder) not in sys.path:
        sys.path.insert(0, str(_folder))

from atrium_photoreal.remote import RemoteFixer, fixer_image  # noqa: E402
from atrium_remaster.models import LAMA_PATH, LAMA_URL, NAFNET_PATH, NAFNET_URL, PROMPT_DEPTH, SAM2  # noqa: E402
from atrium_remaster.triposg import TRIPOSG_COMMIT, TRIPOSG_PATH, TRIPOSG_REPO, TRIPOSG_REVISION, TRIPOSG_WEIGHTS  # noqa: E402

GPU = os.environ.get("REMASTER_GPU", "A10G")
FIXER_GPU = os.environ.get("REMASTER_FIXER_GPU", "A10G")
SHAPE_GPU = os.environ.get("REMASTER_SHAPE_GPU", "A10G")

app = modal.App("atrium-remaster")

# PyTorch with CUDA, Open3D's CPU build for ray casting (it needs EGL, GL and libusb to import),
# and the weights of LaMa (fill), NAFNet (sharpening), Prompt Depth Anything (depth) and SAM 2.1
# (furniture cutouts). Every container imports this file, so each image has both packages.
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libegl1", "libgl1", "libgomp1", "libusb-1.0-0", "curl")
    # transformers 5.19 needs PyTorch 2.6 or later (torch.accelerator), whatever its metadata says.
    .pip_install("torch==2.7.1", "torchvision==0.22.1", index_url="https://download.pytorch.org/whl/cu126")
    .pip_install("numpy<2.3", "scipy", "pillow>=10", "open3d-cpu==0.20.0", "transformers==5.19.0", "xatlas==0.0.11", "shapely==2.2.0", "mapbox-earcut==2.1.0", "fastapi")
    .env({"HF_HOME": "/models/hf"})
    .run_commands(
        f"mkdir -p /models && curl -fsSL -o {LAMA_PATH} {LAMA_URL} && sha256sum {LAMA_PATH}",
        f"curl -fsSL -o {NAFNET_PATH} {NAFNET_URL} && echo '175fe8b3cdf3abedfbc87769779c3d9f491e05bb2e73ea9d627883f90a4b2df3  {NAFNET_PATH}' | sha256sum -c -",
        f"python -c \"from transformers import AutoImageProcessor, PromptDepthAnythingForDepthEstimation as M; AutoImageProcessor.from_pretrained('{PROMPT_DEPTH}'); M.from_pretrained('{PROMPT_DEPTH}')\"",
        f"python -c \"from transformers import Sam2Model, Sam2Processor; Sam2Processor.from_pretrained('{SAM2}'); Sam2Model.from_pretrained('{SAM2}')\"",
    )
    .add_local_python_source("atrium_photoreal", "atrium_remaster")
)
# TripoSG (MIT) at a fixed commit and weights. Its fast decoder's mesher, diso, is stubbed out (its
# license isn't one we take on): the remaster uses the marching-cubes decoder (scikit-image).
shape_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.5.1", "torchvision==0.20.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install(
        "numpy<2.3", "scipy", "pillow>=10", "diffusers==0.32.2", "transformers==4.49.0", "accelerate==1.3.0", "peft==0.14.0",
        "huggingface_hub>=0.26,<1", "einops", "omegaconf", "scikit-image", "trimesh", "jaxtyping", "typeguard", "opencv-python-headless", "fastapi",
    )
    .run_commands(
        f"git clone {TRIPOSG_REPO} /opt/triposg && cd /opt/triposg && git checkout {TRIPOSG_COMMIT}",
        "mkdir -p /opt/stubs/diso && printf 'class DiffDMC:\\n    def __init__(self, *args, **kwargs):\\n        raise RuntimeError(\"diso is not installed\")\\n' > /opt/stubs/diso/__init__.py && cat /opt/stubs/diso/__init__.py",
        f"python -c \"from huggingface_hub import snapshot_download; snapshot_download('{TRIPOSG_WEIGHTS}', revision='{TRIPOSG_REVISION}', local_dir='{TRIPOSG_PATH}')\"",
    )
    .env({"PYTHONPATH": "/opt/triposg:/opt/stubs"})
    .add_local_python_source("atrium_photoreal", "atrium_remaster")
)
web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]").add_local_python_source("atrium_photoreal", "atrium_remaster")

secrets = [modal.Secret.from_name("atrium-photoreal")]

FILE = re.compile(r"^(cameras\.json|seeds\.ply|frames/[A-Za-z0-9_-]+\.(jpg|jpeg|png)|masks/[A-Za-z0-9_-]+\.png)$")


@app.cls(image=fixer_image(modal).add_local_python_source("atrium_remaster"), gpu=FIXER_GPU, timeout=1800, memory=32768, scaledown_window=300, max_containers=1)
class Fixer:
    """NVIDIA Fixer (atrium_photoreal/fixer.py), as the photoreal worker runs it, on a GPU of this app's
    own: cleans up the views where buyers walk (atrium_remaster/fixviews.py)."""

    @modal.enter()
    def load(self):
        from atrium_photoreal.fixer import FixerModel

        self.model = FixerModel()

    @modal.method()
    def warm(self) -> bool:
        return True

    @modal.method()
    def fix(self, jpegs: list[bytes]) -> list[bytes]:
        from atrium_photoreal.fixer import fix_jpegs

        return fix_jpegs(self.model, jpegs)


@app.cls(image=shape_image, gpu=SHAPE_GPU, timeout=1800, memory=32768, scaledown_window=300, max_containers=1)
class Shapes:
    """TripoSG (atrium_remaster/triposg.py) on a GPU of this app's own: furniture shapes from cutouts."""

    @modal.enter()
    def load(self):
        from atrium_remaster.triposg import TripoSG

        self.model = TripoSG()

    @modal.method()
    def make(self, pngs: list[bytes]) -> list[bytes | None]:
        from atrium_remaster.models import pack_shape, unpng

        return [None if s is None else pack_shape(*s) for s in self.model([unpng(p) for p in pngs])]


def services():
    from atrium_remaster.job import Services
    from atrium_remaster.models import LaMa, NAFNetCleaner, PromptDepth, RemoteShapes, Sam2Segmenter

    return Services(
        inpainter=LaMa(), cleaner=NAFNetCleaner(), fixer=RemoteFixer(Fixer()), depth=PromptDepth(), segmenter=Sam2Segmenter(), shapes=RemoteShapes(Shapes())
    )


@app.function(image=gpu_image, gpu=GPU, timeout=1800)
def shape_from_photo(image: bytes, box: list[float]) -> dict:
    """make_shape's work: the cutout (PNG) and the shape (OBJ text) of what's in `box`."""
    from atrium_remaster.furniture import cutout
    from atrium_remaster.models import RemoteShapes, Sam2Segmenter, png, unpng

    photo = unpng(image)
    (mask,) = Sam2Segmenter()(photo, [tuple(box)])
    piece = cutout(photo, mask, 768, 0.1)
    (shape,) = RemoteShapes(Shapes())([piece])
    if shape is None:
        return {"cutout": png(piece), "obj": None, "triangles": 0}
    v, f = shape
    obj = "".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in v) + "".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f)
    return {"cutout": png(piece), "obj": obj, "triangles": int(len(f))}


@app.function(image=gpu_image, gpu=GPU, cpu=8, timeout=3 * 3600, memory=49152, secrets=secrets)
def remaster_job(payload: dict):
    from atrium_remaster.job import run_job

    return run_job(payload, secret=os.environ["PHOTOREAL_WORKER_SECRET"], workdir="/tmp/atrium-remaster", services=services(), device="cuda")


@app.function(image=gpu_image, gpu=GPU, cpu=8, timeout=3 * 3600, memory=49152)
def remaster_files(files: dict[str, bytes], model: bytes, options: dict) -> dict:
    """The remaster of a capture sent as files (name → bytes) and its painted model: the new model's
    bytes and its stats."""
    import tempfile
    from pathlib import Path

    from atrium_photoreal.capture import load
    from atrium_remaster import glb, scene
    from atrium_remaster import layout as layout_mod
    from atrium_remaster.job import remaster

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "capture"
        for name, data in files.items():
            if not FILE.match(name):
                raise ValueError(f"unexpected file: {name}")
            (folder / name).parent.mkdir(parents=True, exist_ok=True)
            (folder / name).write_bytes(data)
        capture = load(folder)
        mesh = scene.from_model(glb.read(model))
        out, stats = remaster(mesh, capture, options, services(), "cuda", lambda stage, value, message: None, layout=layout_mod.load(folder))
        return {"model": glb.write(scene.to_model(out, quality=int(options.get("jpegQuality", 90)))), "stats": stats}


@app.local_entrypoint()
def remaster_folder(capture: str, model: str, out: str, options: str = "{}"):
    import json
    from pathlib import Path

    root = Path(capture)
    files = {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file() and FILE.match(str(p.relative_to(root)))}
    result = remaster_files.remote(files, Path(model).read_bytes(), json.loads(options))
    Path(out).mkdir(parents=True, exist_ok=True)
    (Path(out) / "remastered.glb").write_bytes(result["model"])
    (Path(out) / "stats.json").write_text(json.dumps(result["stats"], indent=2))
    print(json.dumps(result["stats"], indent=2))


@app.local_entrypoint()
def make_shape(image: str, box: str, out: str):
    """One piece of furniture's shape from a photo: SAM 2.1 cuts out what's in `box` (x0,y0,x1,y1 in
    the photo's pixels), TripoSG makes its shape. Writes <out>/cutout.png and <out>/shape.obj."""
    from pathlib import Path

    result = shape_from_photo.remote(Path(image).read_bytes(), [float(v) for v in box.split(",")])
    Path(out).mkdir(parents=True, exist_ok=True)
    (Path(out) / "cutout.png").write_bytes(result["cutout"])
    if result["obj"] is None:
        print("no shape made")
        return
    (Path(out) / "shape.obj").write_text(result["obj"])
    print(f"{result['triangles']} triangles; see {out}")


@app.function(image=web_image, secrets=secrets)
@modal.fastapi_endpoint(method="POST", docs=False)
def start(payload: dict, authorization: str | None = Header(default=None)):
    """Starts a job; answers at once (the GPU function reports progress to the job's callback)."""
    expected = f"Bearer {os.environ['PHOTOREAL_WORKER_SECRET']}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")
    files = payload.get("files")
    callback = payload.get("callback")
    model = payload.get("model")
    if not isinstance(payload.get("jobId"), str) or not isinstance(files, list) or not files:
        raise HTTPException(status_code=400, detail="jobId and files are required")
    if not isinstance(callback, str) or not callback.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise HTTPException(status_code=400, detail="callback must be an https URL")
    if any(not isinstance(f, dict) or not FILE.match(str(f.get("name", ""))) or not str(f.get("url", "")).startswith("http") for f in files):
        raise HTTPException(status_code=400, detail="bad file entry")
    if not isinstance(model, dict) or not str(model.get("url", "")).startswith("http"):
        raise HTTPException(status_code=400, detail="model.url is required")
    call = remaster_job.spawn(payload)
    return {"ok": True, "call": call.object_id}
