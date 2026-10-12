"""Atrium's remaster worker on Modal (https://modal.com), separate from the photoreal one
(worker/photoreal): a GPU function that rebuilds one photo scan's painted model (atrium_remaster), and
a web endpoint the Atrium site calls to start it (REMASTER_GPU_URL on the site). It shares the
photoreal worker's secret. NVIDIA's Fixer runs on a GPU of its own (the photoreal worker's image).

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

import modal
from fastapi import Header, HTTPException

from atrium_photoreal.remote import RemoteFixer, fixer_image
from atrium_remaster.models import LAMA_PATH, LAMA_URL, NAFNET_PATH, NAFNET_URL, PROMPT_DEPTH

GPU = os.environ.get("REMASTER_GPU", "A10G")
FIXER_GPU = os.environ.get("REMASTER_FIXER_GPU", "A10G")

app = modal.App("atrium-remaster")

# PyTorch with CUDA, Open3D's CPU build for ray casting (it needs EGL, GL and libusb to import),
# and the weights of LaMa (fill), NAFNet (sharpening) and Prompt Depth Anything (depth). Every
# container imports this file, so each image has both packages.
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libegl1", "libgl1", "libgomp1", "libusb-1.0-0", "curl")
    .pip_install("torch==2.5.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("numpy<2.3", "scipy", "pillow>=10", "open3d-cpu==0.20.0", "transformers==5.19.0", "xatlas==0.0.11", "shapely==2.2.0", "mapbox-earcut==2.1.0", "fastapi")
    .env({"HF_HOME": "/models/hf"})
    .run_commands(
        f"mkdir -p /models && curl -fsSL -o {LAMA_PATH} {LAMA_URL} && sha256sum {LAMA_PATH}",
        f"curl -fsSL -o {NAFNET_PATH} {NAFNET_URL} && echo '175fe8b3cdf3abedfbc87769779c3d9f491e05bb2e73ea9d627883f90a4b2df3  {NAFNET_PATH}' | sha256sum -c -",
        f"python -c \"from transformers import AutoImageProcessor, PromptDepthAnythingForDepthEstimation as M; AutoImageProcessor.from_pretrained('{PROMPT_DEPTH}'); M.from_pretrained('{PROMPT_DEPTH}')\"",
    )
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


def services():
    from atrium_remaster.job import Services
    from atrium_remaster.models import LaMa, NAFNetCleaner, PromptDepth

    return Services(inpainter=LaMa(), cleaner=NAFNetCleaner(), fixer=RemoteFixer(Fixer()), depth=PromptDepth())


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
