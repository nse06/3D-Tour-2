"""tools/eval_remaster.py on Modal's GPUs: a GPU per variant (the remaster worker's image, LaMa for
the fill), results written here.

  cd prototypes/photoreal
  tools/eval_data.sh                   # eval-data/: captures, painted models and the real views
  modal run tools/eval_remaster_modal.py --capture eval-data/capture-rough --painted eval-data/painted-rough.glb \
      --views eval-data/views --out eval-data/remaster [--variants painted,skins,skins+fill] [--steps 0]

Uploads the capture, the painted model and the views to the Modal volume "atrium-photoreal-eval" and
runs every variant at once on an A10G with 8 CPUs each (the remaster worker's machine).
"""

import hashlib
import sys
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
if len(HERE.parents) > 2 and (HERE.parents[2] / "worker" / "remaster").is_dir():
    sys.path[:0] = [str(HERE), str(HERE.parents[2] / "worker" / "photoreal"), str(HERE.parents[2] / "worker" / "remaster")]

from atrium_photoreal.remote import RemoteFixer, fixer_image  # noqa: E402  (after the path above)
from atrium_remaster.models import LAMA_PATH, LAMA_URL, NAFNET_PATH, NAFNET_URL, PROMPT_DEPTH  # noqa: E402

app = modal.App("atrium-remaster-eval")
volume = modal.Volume.from_name("atrium-photoreal-eval", create_if_missing=True)
# The remaster worker's image (worker/remaster/modal_app.py), plus LPIPS (torchvision's AlexNet).
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libegl1", "libgl1", "libgomp1", "libusb-1.0-0", "curl")
    .pip_install("torch==2.7.1", "torchvision==0.22.1", index_url="https://download.pytorch.org/whl/cu126")  # as the worker's
    .pip_install("numpy<2.3", "scipy", "pillow>=10", "open3d-cpu==0.20.0", "transformers==5.19.0", "xatlas==0.0.11", "shapely==2.2.0", "mapbox-earcut==2.1.0", "lpips==0.1.4")
    .env({"HF_HOME": "/models/hf"})
    .run_commands(
        f"mkdir -p /models && curl -fsSL -o {LAMA_PATH} {LAMA_URL} && sha256sum {LAMA_PATH}",
        f"curl -fsSL -o {NAFNET_PATH} {NAFNET_URL} && sha256sum {NAFNET_PATH}",
        f"python -c \"from transformers import AutoImageProcessor, PromptDepthAnythingForDepthEstimation as M; AutoImageProcessor.from_pretrained('{PROMPT_DEPTH}'); M.from_pretrained('{PROMPT_DEPTH}')\"",
    )
    .add_local_python_source("atrium_photoreal", "atrium_remaster", "eval_splats", "eval_remaster")
)


@app.cls(image=fixer_image(modal).add_local_python_source("atrium_remaster", "eval_splats", "eval_remaster"), gpu="A10G", timeout=1800, memory=32768, scaledown_window=300, max_containers=1)
class Fixer:
    """NVIDIA Fixer, as in worker/remaster/modal_app.py."""

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


@app.function(image=image, gpu="A10G", cpu=8, timeout=3 * 3600, memory=49152, volumes={"/data": volume})
def evaluate(tag: str, variant: str, steps: int) -> dict:
    import eval_remaster
    from atrium_remaster.job import Services
    from atrium_remaster.models import LaMa, NAFNetCleaner, PromptDepth

    overrides = {"steps": steps} if steps else None
    fixer = RemoteFixer(Fixer()) if eval_remaster.uses_fixer(variant) else None
    services = Services(inpainter=LaMa(), cleaner=NAFNetCleaner(), fixer=fixer, depth=PromptDepth())
    return eval_remaster.run_variant(f"/data/{tag}/capture", f"/data/{tag}/painted.glb", f"/data/{tag}/views", variant, "cuda", 1.0, overrides, services)


@app.local_entrypoint()
def main(capture: str, painted: str, views: str, out: str, variants: str = "painted,skins,skins+fill,full,full+depth,full+trim,full+fixer", steps: int = 0):
    import eval_remaster

    names = [n for n in variants.split(",") if n]
    unknown = [n for n in names if n not in eval_remaster.VARIANTS]
    if unknown:
        raise SystemExit(f"unknown variants {unknown}; known: {list(eval_remaster.VARIANTS)}")
    capture_dir, painted_glb, views_dir = Path(capture).resolve(), Path(painted).resolve(), Path(views).resolve()
    tag = "remaster-" + hashlib.sha1(f"{capture_dir}|{painted_glb}|{views_dir}".encode()).hexdigest()[:10]
    print(f"uploading {capture_dir}, {painted_glb} and {views_dir} to the volume ({tag})")
    with volume.batch_upload(force=True) as batch:
        batch.put_directory(str(capture_dir), f"/{tag}/capture")
        batch.put_file(str(painted_glb), f"/{tag}/painted.glb")
        batch.put_directory(str(views_dir), f"/{tag}/views")
    print(f"remastering {', '.join(names)}, a GPU each")
    results = []
    for name, scored in zip(names, evaluate.starmap([(tag, n, steps) for n in names], return_exceptions=True)):
        if isinstance(scored, BaseException):
            print(f"{name} failed: {type(scored).__name__}: {scored}")
            continue
        print(f"{name}: {scored['stats']}")
        results.append(scored)
    if results:
        eval_remaster.write_results(Path(out), views_dir, results)
