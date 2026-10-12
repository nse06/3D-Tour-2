"""Runs one photoreal job the Atrium site handed over:

    {"jobId": "...", "callback": "https://<site>/api/photoreal/jobs/<id>",
     "files": [{"name": "cameras.json", "url": "<signed download URL>"}, ...],
     "options": {"steps": 30000, "longSide": 1920, "maxGaussians": 1000000, "maxMB": 45,
                 "aiVersion": true, "aiViews": 120, "aiRounds": 3, "aiStepsPerRound": 1500}}

Downloads the capture, trains, writes the splats as .spz, asks the callback where to upload them,
uploads, and reports back. Every call to the callback carries the shared worker secret
(Authorization: Bearer ...). The callback hears: {"event": "progress", "stage", "progress",
"message"}, {"event": "upload", "bytes"} (answered with {"url", "method", "headers", "assetUrl"}),
{"event": "done", "assetUrl", "stats", "spots"} or {"event": "failed", "message"}. `spots` says
where each photo was taken, [x, y, z, yaw, pitch] (meters and radians in the model's frame; yaw 0
looks along -z): the viewer shows the splats near those spots and the painted model elsewhere.

With a fixer and "aiVersion": true, training goes on for the AI-enhanced version (enhance.py)
after the faithful one is delivered: "done" then says {"pending": ["ai"]}, the AI phase reports
{"event": "progress", "variant": "ai", ...}, uploads with {"event": "upload", "variant": "ai",
"bytes"} and ends with {"event": "variant", "name": "ai", "status": "done", "assetUrl", "stats"}, or
{"event": "variant", "name": "ai", "status": "failed", "message"} (the faithful version stays).
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

    def progress(self, stage: str, value: float, message: str = "", force: bool = False, variant: str | None = None):
        now = time.time()
        if not force and now - self.last < self.every:
            return
        self.last = now
        body = {"event": "progress", "stage": stage, "progress": round(max(0.0, min(1.0, value)), 4), "message": message}
        if variant:
            body["variant"] = variant
        try:
            self.send(body)
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


def run_job(payload: dict, secret: str, workdir: str | Path = "/tmp/atrium-photoreal", fixer=None) -> dict:
    """`fixer`: cleans up renders for the AI-enhanced version (enhance.Fixer); None: the faithful one only."""
    from .capture import load
    from .enhance import AIVersion, EnhanceConfig
    from .train import TrainConfig, train

    reporter = Reporter(payload["callback"], secret)
    work = Path(workdir) / str(payload["jobId"])
    shutil.rmtree(work, ignore_errors=True)
    capture_dir = work / "capture"
    capture_dir.mkdir(parents=True)
    delivered: dict[str, dict] = {}
    try:
        started = time.time()
        reporter.progress("downloading", 0, f"{len(payload['files'])} files", force=True)
        received = download(payload["files"], capture_dir)
        capture = load(capture_dir)
        reporter.progress("training", 0, f"{len(capture.cameras)} photos, {received / 1e6:.0f} MB", force=True)

        options = payload.get("options") or {}
        defaults = TrainConfig()
        cfg = TrainConfig(
            steps=int(options.get("steps", defaults.steps)),
            long_side=int(options.get("longSide", defaults.long_side)),
            max_gaussians=int(options.get("maxGaussians", defaults.max_gaussians)),
        )
        max_bytes = int(float(options.get("maxMB", 45)) * 1e6)
        spots = photo_spots(capture)

        def deliver(result, name: str, variant: str | None = None) -> tuple[str, dict]:
            """Writes the splats, uploads them where the site says; their URL and stats."""
            out = work / name
            written = write_splats(out, result.splats, result.sh_degree, max_bytes)
            stats = {**result.stats, **written, "downloadMB": round(received / 1e6, 1), "totalSeconds": round(time.time() - started, 1)}
            target = reporter.send({"event": "upload", "bytes": written["bytes"], "stats": stats, **({"variant": variant} if variant else {})})
            if not target.get("url"):
                raise RuntimeError(f"no upload target: {target}")
            upload(target, out)
            return target["assetUrl"], stats

        ai = None
        # Only when the site asks for it: a site from before the AI version can't take its reports.
        if fixer is not None and options.get("aiVersion") is True:
            ai_defaults = EnhanceConfig()
            ai_cfg = EnhanceConfig(
                views=int(options.get("aiViews", ai_defaults.views)),
                rounds=int(options.get("aiRounds", ai_defaults.rounds)),
                steps_per_round=int(options.get("aiStepsPerRound", ai_defaults.steps_per_round)),
                width=int(options.get("aiWidth", ai_defaults.width)),
                height=int(options.get("aiHeight", ai_defaults.height)),
            )

            def on_main(result):
                # The faithful version: delivered before the AI phase starts.
                reporter.progress("uploading", 1, "", force=True)
                url, stats = deliver(result, "splats.spz")
                reporter.send({"event": "done", "assetUrl": url, "stats": stats, "spots": spots, "pending": ["ai"]})
                delivered["main"] = stats

            ai = AIVersion(fixer=fixer, config=ai_cfg, on_main=on_main)

        result = train(
            capture,
            cfg,
            progress=lambda value, message: reporter.progress("training", value, message),
            ai=ai,
            ai_progress=lambda value, message: reporter.progress("ai", value, message, variant="ai"),
        )
        if ai:
            reporter.progress("ai", 1, "saving", force=True, variant="ai")
            url, stats = deliver(result, "splats-ai.spz", variant="ai")
            reporter.send({"event": "variant", "name": "ai", "status": "done", "assetUrl": url, "stats": stats})
            return {**delivered["main"], "ai": stats}

        reporter.progress("uploading", 1, "", force=True)
        url, stats = deliver(result, "splats.spz")
        reporter.send({"event": "done", "assetUrl": url, "stats": stats, "spots": spots})
        return stats
    except Exception as e:
        traceback.print_exc()
        message = f"{type(e).__name__}: {e}"[:500]
        if "main" in delivered:
            # Only the AI version failed: the faithful one is delivered and stays.
            try:
                reporter.send({"event": "variant", "name": "ai", "status": "failed", "message": message})
            except Exception:
                traceback.print_exc()
            return delivered["main"]
        try:
            reporter.send({"event": "failed", "message": message})
        except Exception:
            traceback.print_exc()
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
