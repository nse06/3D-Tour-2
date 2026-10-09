"""Runs one photoreal job the Atrium site handed over:

    {"jobId": "...", "callback": "https://<site>/api/photoreal/jobs/<id>",
     "files": [{"name": "cameras.json", "url": "<signed download URL>"}, ...],
     "options": {"steps": 30000, "longSide": 1440, "maxGaussians": 1000000, "maxMB": 45}}

Downloads the capture, trains, writes the splats as .spz, asks the callback where to upload them,
uploads, and reports back. Every call to the callback carries the shared worker secret
(Authorization: Bearer ...). The callback hears: {"event": "progress", "stage", "progress",
"message"}, {"event": "upload", "bytes"} (answered with {"url", "method", "headers", "assetUrl"}),
{"event": "done", "assetUrl", "stats", "spots"} or {"event": "failed", "message"}. `spots` says
where each photo was taken, [x, y, z, yaw, pitch] (meters and radians in the model's frame; yaw 0
looks along -z): the viewer shows the splats near those spots and the painted model elsewhere.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import time
import traceback
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

NAME = re.compile(r"^(cameras\.json|seeds\.ply|frames/[A-Za-z0-9_-]+\.(jpg|jpeg|png)|masks/[A-Za-z0-9_-]+\.png)$")


class Reporter:
    def __init__(self, callback: str, secret: str, every: float = 20.0):
        self.callback, self.secret, self.every = callback, secret, every
        self.last = 0.0

    def send(self, body: dict, timeout: float = 30) -> dict:
        request = urllib.request.Request(
            self.callback,
            data=json.dumps(body).encode(),
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.secret}"},
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    text = response.read().decode() or "{}"
                    return json.loads(text)
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2**attempt)
        return {}

    def progress(self, stage: str, value: float, message: str = "", force: bool = False):
        now = time.time()
        if not force and now - self.last < self.every:
            return
        self.last = now
        try:
            self.send({"event": "progress", "stage": stage, "progress": round(max(0.0, min(1.0, value)), 4), "message": message})
        except Exception as e:  # progress is best effort
            print(f"progress report failed: {e}")


def download(files: list[dict], folder: Path, threads: int = 16) -> int:
    def fetch(entry):
        name = entry["name"]
        if not NAME.match(name):
            raise ValueError(f"unexpected file in the capture: {name!r}")
        target = folder / name
        target.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(entry["url"], timeout=120) as response, open(target, "wb") as out:
                    shutil.copyfileobj(response, out, 1 << 20)
                return target.stat().st_size
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2**attempt)

    with ThreadPoolExecutor(threads) as pool:
        return sum(pool.map(fetch, files))


def upload(target: dict, path: Path):
    request = urllib.request.Request(target["url"], data=path.read_bytes(), method=target.get("method", "PUT"), headers=target.get("headers", {}))
    with urllib.request.urlopen(request, timeout=600) as response:
        response.read()


def write_splats(out: Path, splats: dict, sh_degree: int, max_bytes: int) -> dict:
    """Writes the .spz, dropping view-dependent color (the highest SH bands first) until it fits
    `max_bytes`: buyers download it, and Supabase's free plan takes files up to 50 MB."""
    import torch

    from . import spz

    sh = torch.cat([splats["sh0"], splats["shN"]], 1).numpy()
    for degree in range(sh_degree, -1, -1):
        written = spz.write(out, splats["means"].numpy(), splats["scales"].numpy(), splats["quats"].numpy(), splats["opacities"].numpy(), sh, degree)
        if written["bytes"] <= max_bytes:
            break
    return {**written, "trainedShDegree": sh_degree}


def photo_spots(capture) -> list[list[float]]:
    """Where each photo was taken and which way it looked: [x, y, z, yaw, pitch]."""
    spots = []
    for camera in capture.cameras:
        c2w = camera.camtoworld
        f = c2w[:3, 2]  # OpenCV: the camera looks along +z
        x, y, z = c2w[:3, 3]
        yaw, pitch = math.atan2(-f[0], -f[2]), math.asin(max(-1.0, min(1.0, float(f[1]))))
        spots.append([round(float(v), 3) for v in (x, y, z, yaw, pitch)])
    return spots


def run_job(payload: dict, secret: str, workdir: str | Path = "/tmp/atrium-photoreal") -> dict:
    from .capture import load
    from .train import TrainConfig, train

    reporter = Reporter(payload["callback"], secret)
    work = Path(workdir) / str(payload["jobId"])
    shutil.rmtree(work, ignore_errors=True)
    capture_dir = work / "capture"
    capture_dir.mkdir(parents=True)
    try:
        started = time.time()
        reporter.progress("downloading", 0, f"{len(payload['files'])} files", force=True)
        received = download(payload["files"], capture_dir)
        capture = load(capture_dir)
        reporter.progress("training", 0, f"{len(capture.cameras)} photos, {received / 1e6:.0f} MB", force=True)

        options = payload.get("options") or {}
        cfg = TrainConfig(
            steps=int(options.get("steps", 30_000)),
            long_side=int(options.get("longSide", 1440)),
            max_gaussians=int(options.get("maxGaussians", 1_000_000)),
        )
        result = train(capture, cfg, progress=lambda value, message: reporter.progress("training", value, message))

        reporter.progress("uploading", 1, "", force=True)
        out = work / "splats.spz"
        written = write_splats(out, result.splats, result.sh_degree, int(float(options.get("maxMB", 45)) * 1e6))
        stats = {**result.stats, **written, "downloadMB": round(received / 1e6, 1), "totalSeconds": round(time.time() - started, 1)}
        target = reporter.send({"event": "upload", "bytes": written["bytes"], "stats": stats})
        if not target.get("url"):
            raise RuntimeError(f"no upload target: {target}")
        upload(target, out)
        reporter.send({"event": "done", "assetUrl": target["assetUrl"], "stats": stats, "spots": photo_spots(capture)})
        return stats
    except Exception as e:
        traceback.print_exc()
        try:
            reporter.send({"event": "failed", "message": f"{type(e).__name__}: {e}"[:500]})
        except Exception:
            traceback.print_exc()
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
