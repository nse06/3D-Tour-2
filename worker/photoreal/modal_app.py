"""Atrium's photoreal worker on Modal (https://modal.com): a GPU function that trains one capture,
and a web endpoint the Atrium site calls to start it (PHOTOREAL_GPU_URL on the site).

Setup (once; see docs/photoreal.md):

    pip install modal fastapi && modal setup  # or MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in the environment
    modal secret create atrium-photoreal PHOTOREAL_WORKER_SECRET=<the same value as on the site>
    cd worker/photoreal && modal deploy modal_app.py

The deploy prints the endpoint's URL (https://<workspace>--atrium-photoreal-start.modal.run): set it
as PHOTOREAL_GPU_URL on the site. A job costs the GPU's time only (about 20-35 minutes on an A10G).
"""

import hmac
import os
import re

import modal
from fastapi import Header, HTTPException

GPU = os.environ.get("PHOTOREAL_GPU", "A10G")

app = modal.App("atrium-photoreal")

# gsplat's prebuilt CUDA wheels (PyTorch 2.4, CUDA 12.4, Python 3.10): nothing to compile.
gpu_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("torch==2.4.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("gsplat==1.5.3+pt24cu124", extra_index_url="https://docs.gsplat.studio/whl/pt24cu124")
    .pip_install("numpy<2", "pillow>=10", "jaxtyping", "rich", "packaging", "fastapi")  # packaging: gsplat imports it; fastapi: modal_app.py imports it in every container
    .add_local_python_source("atrium_photoreal")
)
web_image = modal.Image.debian_slim(python_version="3.10").pip_install("fastapi[standard]")
secrets = [modal.Secret.from_name("atrium-photoreal")]

FILE = re.compile(r"^(cameras\.json|seeds\.ply|frames/[A-Za-z0-9_-]+\.(jpg|jpeg|png)|masks/[A-Za-z0-9_-]+\.png)$")


@app.function(image=gpu_image, gpu=GPU, timeout=3 * 3600, memory=32768, secrets=secrets)
def train_job(payload: dict):
    from atrium_photoreal.job import run_job

    return run_job(payload, secret=os.environ["PHOTOREAL_WORKER_SECRET"], workdir="/tmp/atrium-photoreal")


@app.function(image=web_image, secrets=secrets)
@modal.fastapi_endpoint(method="POST", docs=False)
def start(payload: dict, authorization: str | None = Header(default=None)):
    """Starts a job; answers at once (the GPU function reports progress to the job's callback)."""
    expected = f"Bearer {os.environ['PHOTOREAL_WORKER_SECRET']}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")
    files = payload.get("files")
    callback = payload.get("callback")
    if not isinstance(payload.get("jobId"), str) or not isinstance(files, list) or not files:
        raise HTTPException(status_code=400, detail="jobId and files are required")
    if not isinstance(callback, str) or not callback.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise HTTPException(status_code=400, detail="callback must be an https URL")
    if any(not isinstance(f, dict) or not FILE.match(str(f.get("name", ""))) or not str(f.get("url", "")).startswith("http") for f in files):
        raise HTTPException(status_code=400, detail="bad file entry")
    call = train_job.spawn(payload)
    return {"ok": True, "call": call.object_id}
