"""tools/eval_splats.py on Modal's GPUs (https://modal.com): a GPU per variant, results written here.

  pip install modal                    # behind an HTTPS proxy: pip install 'modal[api-proxy-support]'
  cd prototypes/photoreal
  tools/eval_data.sh                   # eval-data/: captures and the real views (see that script)
  modal run tools/eval_modal.py --capture eval-data/capture-rough --views eval-data/views --out eval-data/results
        [--variants baseline,priors] [--steps 30000] [--long-side 1440]

Uploads the capture and the views to the Modal volume "atrium-photoreal-eval", trains every variant at
once on an A10G each (the worker's GPU), and writes what tools/eval_splats.py writes into --out. The
synthetic photos are 480 x 360, so a variant takes about 10-15 minutes, roughly $0.20-0.30.
"""

import hashlib
import sys
from pathlib import Path

import modal

# Locally: this folder and the worker's package, for the image to pick up (Modal's containers have both).
HERE = Path(__file__).resolve().parent
if len(HERE.parents) > 2 and (HERE.parents[2] / "worker" / "photoreal").is_dir():
    sys.path[:0] = [str(HERE), str(HERE.parents[2] / "worker" / "photoreal")]

GPU = "A10G"
app = modal.App("atrium-photoreal-eval")
volume = modal.Volume.from_name("atrium-photoreal-eval", create_if_missing=True)
# The worker's image (worker/photoreal/modal_app.py), plus LPIPS (torchvision's AlexNet).
image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("torch==2.4.1", "torchvision==0.19.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("gsplat==1.5.3+pt24cu124", extra_index_url="https://docs.gsplat.studio/whl/pt24cu124")
    .pip_install("numpy<2", "pillow>=10", "jaxtyping", "rich", "packaging", "lpips==0.1.4")
    .add_local_python_source("atrium_photoreal", "eval_splats")
)


@app.function(image=image, gpu=GPU, timeout=3 * 3600, memory=32768, volumes={"/data": volume})
def evaluate(tag: str, variant: str, steps: int, long_side: int) -> dict:
    import eval_splats

    return eval_splats.run_variant(f"/data/{tag}/capture", f"/data/{tag}/views", variant, steps, long_side, device="cuda")


@app.local_entrypoint()
def main(capture: str, views: str, out: str, variants: str = "baseline,shell,shell+aniso,priors,priors-aniso3,priors-sh1", steps: int = 30_000, long_side: int = 1440):
    import eval_splats

    names = [n for n in variants.split(",") if n]
    unknown = [n for n in names if n not in eval_splats.VARIANTS]
    if unknown:
        raise SystemExit(f"unknown variants {unknown}; known: {list(eval_splats.VARIANTS)}")
    capture_dir, views_dir = Path(capture).resolve(), Path(views).resolve()
    # The same inputs go to the same place on the volume.
    tag = hashlib.sha1(f"{capture_dir}|{views_dir}".encode()).hexdigest()[:10]
    print(f"uploading {capture_dir} and {views_dir} to the volume ({tag})")
    with volume.batch_upload(force=True) as batch:
        batch.put_directory(str(capture_dir), f"/{tag}/capture")
        batch.put_directory(str(views_dir), f"/{tag}/views")
    print(f"training {', '.join(names)} ({steps} steps), a GPU each")
    results = []
    for name, result in zip(names, evaluate.starmap([(tag, n, steps, long_side) for n in names], return_exceptions=True)):
        if isinstance(result, BaseException):
            print(f"{name} failed: {type(result).__name__}: {result}")
            continue
        print(f"{name}: {result['stats']}")
        results.append(result)
    if results:
        eval_splats.write_results(Path(out), views_dir, results)
