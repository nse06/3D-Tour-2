# Photoreal worker

Turns a phone scan's photos into a photoreal walkthrough: 3D Gaussian splats trained on a cloud GPU,
saved as `.spz` for the tour viewer. The whole pipeline is described in
[docs/photoreal.md](../../docs/photoreal.md); this folder is the GPU side.

| File | What it does |
|---|---|
| `atrium_photoreal/capture.py` | Reads what the app uploads: `cameras.json` (poses in the model's frame), `seeds.ply`, `frames/`, `masks/` |
| `atrium_photoreal/train.py` | gsplat's 3DGS recipe (MCMC on a GPU) with splats starting as discs on the painted surfaces, per-photo exposure, pose refinement, people left out, bounds |
| `atrium_photoreal/shell.py` | The room's shape: splats on walls, floors and ceilings kept flat on them, no needles, floaters in front of the cameras cleared |
| `atrium_photoreal/render.py` | gsplat's CUDA rasterizer; a dense PyTorch one on the CPU for tests |
| `atrium_photoreal/spz.py` | SPZ v3 writer/reader (checked against three.js's `SPZLoader`) |
| `atrium_photoreal/job.py` | One job: download, train, write the `.spz` (under 45 MB: the highest view-dependent color bands go first), upload, report to the Atrium site (with where each photo was taken) |
| `modal_app.py` | The Modal app: `train_job` on a GPU, and the `start` endpoint the site calls |
| `run_local.py` | Train a capture folder on this machine |

## Test (CPU)

```sh
cd worker/photoreal
pip install -r requirements.txt pytest
python -m pytest tests -q        # ~1.5 min: conventions, .spz, the room's shape, a small training run, the job protocol
```

To judge a change to training where it matters (views no photo matches, close to walls), train it on the synthetic
apartment and score it against the real thing: `prototypes/photoreal/tools/eval_data.sh`, then
`modal run tools/eval_modal.py` there (see `prototypes/photoreal/README.md`).

A capture folder for `run_local.py` comes from the app (a scan's `photoreal/` folder plus its
`frames/`) or from `scanproc paint <scan.json> <out.glb> --images <dir> --photoreal <dir>`.

## Deploy on Modal

```sh
pip install modal fastapi                      # behind an HTTPS proxy: 'modal[api-proxy-support]' fastapi
modal setup                                   # or MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in the environment
modal secret create atrium-photoreal PHOTOREAL_WORKER_SECRET=<a long random string>
cd worker/photoreal && modal deploy modal_app.py
```

Then on the site (Vercel → Settings → Environment Variables): `PHOTOREAL_GPU_URL` = the `start`
endpoint's URL the deploy printed, and `PHOTOREAL_WORKER_SECRET` = the same secret. Redeploy the site.

A job runs 20–35 minutes on an A10G (`PHOTOREAL_GPU=L4` at deploy time for a cheaper, slower GPU),
roughly $0.40–0.70 per home; Modal's free tier includes $30 a month.
