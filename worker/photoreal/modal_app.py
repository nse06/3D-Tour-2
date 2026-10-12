"""Atrium's photoreal worker on Modal (https://modal.com): a GPU function that trains one capture,
a web endpoint the Atrium site calls to start it (PHOTOREAL_GPU_URL on the site), and NVIDIA's Fixer
on a GPU of its own for the AI-enhanced version (atrium_photoreal/enhance.py).

Setup (once; see docs/photoreal.md):

    pip install modal fastapi && modal setup  # or MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in the environment
    modal secret create atrium-photoreal PHOTOREAL_WORKER_SECRET=<the same value as on the site>
    cd worker/photoreal && modal deploy modal_app.py

The deploy prints the endpoint's URL (https://<workspace>--atrium-photoreal-start.modal.run): set it
as PHOTOREAL_GPU_URL on the site. A job costs the GPUs' time only (about 35-50 minutes on an A10G for
the faithful version, 10-15 more for the AI-enhanced one, a few of them on the Fixer's GPU).

The Fixer on its own, on a folder of renders (writes cleaned copies and side-by-sides):

    modal run modal_app.py::fixer_smoke --images <folder of .jpg/.png> --out <folder>
"""

import hmac
import os
import re

import modal
from fastapi import Header, HTTPException

from atrium_photoreal.remote import RemoteFixer, fixer_image

GPU = os.environ.get("PHOTOREAL_GPU", "A10G")
FIXER_GPU = os.environ.get("PHOTOREAL_FIXER_GPU", "A10G")

app = modal.App("atrium-photoreal")

# gsplat's prebuilt CUDA wheels (PyTorch 2.4, CUDA 12.4, Python 3.10): nothing to compile.
gpu_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("torch==2.4.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("gsplat==1.5.3+pt24cu124", extra_index_url="https://docs.gsplat.studio/whl/pt24cu124")
    .pip_install("numpy<2", "pillow>=10", "jaxtyping", "rich", "packaging", "fastapi")  # packaging: gsplat imports it; fastapi: modal_app.py imports it in every container
    .add_local_python_source("atrium_photoreal")
)
# Every container imports this file, so each image has atrium_photoreal (remote.py, imported below).
web_image = modal.Image.debian_slim(python_version="3.10").pip_install("fastapi[standard]").add_local_python_source("atrium_photoreal")

secrets = [modal.Secret.from_name("atrium-photoreal")]

FILE = re.compile(r"^(cameras\.json|seeds\.ply|frames/[A-Za-z0-9_-]+\.(jpg|jpeg|png)|masks/[A-Za-z0-9_-]+\.png)$")


@app.cls(image=fixer_image(modal), gpu=FIXER_GPU, timeout=1800, memory=32768, scaledown_window=300, max_containers=1)
class Fixer:
    """NVIDIA Fixer (atrium_photoreal/fixer.py): one GPU (jobs at the same time take turns), kept loaded
    between the AI phase's rounds (scaledown_window)."""

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


@app.function(image=gpu_image, gpu=GPU, timeout=3 * 3600, memory=32768, secrets=secrets)
def train_job(payload: dict):
    from atrium_photoreal.job import run_job

    return run_job(payload, secret=os.environ["PHOTOREAL_WORKER_SECRET"], workdir="/tmp/atrium-photoreal", fixer=RemoteFixer(Fixer()))


@app.local_entrypoint()
def fixer_smoke(images: str, out: str):
    """Runs the Fixer on a folder of renders: <out>/<name>.jpg, cleaned, and <out>/<name>-pair.jpg, before | after."""
    from pathlib import Path

    import numpy as np
    from PIL import Image

    from atrium_photoreal.enhance import from_jpeg, to_jpeg

    files = sorted(p for p in Path(images).iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    sources = [np.asarray(Image.open(p).convert("RGB").resize((1024, 576), Image.BILINEAR)) for p in files]
    fixed = [from_jpeg(b) for b in Fixer().fix.remote([to_jpeg(im) for im in sources])]
    Path(out).mkdir(parents=True, exist_ok=True)
    for p, before, after in zip(files, sources, fixed):
        Image.fromarray(after).save(Path(out) / f"{p.stem}.jpg", quality=92)
        Image.fromarray(np.concatenate([before, after], 1)).save(Path(out) / f"{p.stem}-pair.jpg", quality=88)
    print(f"{len(files)} renders cleaned up into {out}")


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
