"""Atrium's remaster worker on Modal (https://modal.com), separate from the photoreal one
(worker/photoreal): a GPU function that rebuilds one photo scan's painted model (atrium_remaster), and
a web endpoint the Atrium site calls to start it (REMASTER_GPU_URL on the site). It shares the
photoreal worker's secret.

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

from atrium_remaster.models import LAMA_PATH, LAMA_URL

GPU = os.environ.get("REMASTER_GPU", "A10G")

app = modal.App("atrium-remaster")

# PyTorch with CUDA, Open3D's CPU build for ray casting (it needs EGL and GL libraries to import),
# and LaMa's weights. Every container imports this file, so each image has both packages.
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libegl1", "libgl1", "libgomp1", "curl")
    .pip_install("torch==2.5.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("numpy<2.3", "scipy", "pillow>=10", "open3d-cpu==0.20.0", "fastapi")
    .run_commands(f"mkdir -p /models && curl -fsSL -o {LAMA_PATH} {LAMA_URL} && sha256sum {LAMA_PATH}")
    .add_local_python_source("atrium_photoreal", "atrium_remaster")
)
web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]").add_local_python_source("atrium_photoreal", "atrium_remaster")

secrets = [modal.Secret.from_name("atrium-photoreal")]

FILE = re.compile(r"^(cameras\.json|seeds\.ply|frames/[A-Za-z0-9_-]+\.(jpg|jpeg|png)|masks/[A-Za-z0-9_-]+\.png)$")


def services():
    from atrium_remaster.job import Services
    from atrium_remaster.models import LaMa

    return Services(inpainter=LaMa())


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
        out, stats = remaster(mesh, capture, options, services(), "cuda", lambda stage, value, message: None)
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
