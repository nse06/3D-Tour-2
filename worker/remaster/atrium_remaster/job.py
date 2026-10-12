"""Runs one remaster job the Atrium site handed over (docs/remaster.md §5):

    {"jobId": "...", "callback": "https://<site>/api/remaster/jobs/<id>",
     "files": [{"name": "cameras.json", "url": "<signed download URL>"}, ...],   the kept photos
     "model": {"url": "<the painted model (.glb)>"},
     "options": {"steps": 3000, "scale": 2, "longSide": 1920, "fill": true, ...}}

Downloads the photos and the painted model, rebuilds the model (the stages below, each optional but
the skins), asks the callback where to upload the files, uploads them, and reports back. Every call
carries the shared worker secret (Authorization: Bearer ...). The callback hears:
{"event": "progress", "stage", "progress", "message"}; {"event": "upload", "files": [{"name",
"bytes"}]}, answered with {"targets": [{"name", "url", "method", "headers", "assetUrl"}]};
{"event": "done", "modelUrl", "stats"} or {"event": "failed", "message"}.

The photoreal splats (worker/photoreal) are a separate job; this one borrows its helpers.
"""

from __future__ import annotations

import shutil
import time
import traceback
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from atrium_photoreal.capture import load
from atrium_photoreal.job import Reporter, download, upload

from . import cleanup as cleanup_mod
from . import depth as depth_mod
from . import fill as fill_mod
from . import fixviews
from . import glb, scene, skins
from . import layout as layout_mod
from .layout import Layout
from .views import Caster


@dataclass
class Services:
    """The AI models a job can call (models.py on a GPU; stand-ins or nothing in tests)."""

    inpainter: fill_mod.Inpainter = field(default_factory=fill_mod.PullPush)
    cleaner: cleanup_mod.Cleaner | None = None
    fixer: object | None = None  # atrium_photoreal.enhance.Fixer: views where buyers walk, cleaned up
    depth: depth_mod.DepthModel | None = None


def fetch(url: str, target: Path) -> int:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=300) as response, open(target, "wb") as out:
                shutil.copyfileobj(response, out, 1 << 20)
            return target.stat().st_size
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2**attempt)
    return 0


def photos_match(mesh: scene.Mesh, capture, sample: int = 12) -> float:
    """The share of the photos' pixels that land on the model (a quarter-size check): about all of
    them when the photos and the model come from the same scan, few when not."""
    caster = Caster.of(mesh)
    shares = []
    step = max(1, len(capture.cameras) // sample)
    for cam in capture.cameras[::step]:
        s = 0.125
        K = cam.K.copy()
        K[:2] *= s
        hits = caster.view(K, cam.camtoworld, max(8, int(cam.width * s)), max(6, int(cam.height * s)))
        shares.append(float(hits.hit.mean()))
    return float(np.median(shares)) if shares else 0.0


def config_from(options: dict) -> skins.SkinConfig:
    d = skins.SkinConfig()
    return skins.SkinConfig(
        scale=float(options.get("scale", d.scale)),
        max_texels=int(options.get("maxTexels", d.max_texels)),
        long_side=int(options.get("longSide", d.long_side)),
        steps=int(options.get("steps", d.steps)),
        batch=int(options.get("batch", d.batch)),
        tile=int(options.get("tile", d.tile)),
        levels=int(options.get("levels", d.levels)),
        max_mip=int(options.get("maxMip", d.max_mip)),
        align=bool(options.get("align", d.align)),
    )


def cleanup_config(options: dict) -> cleanup_mod.CleanupConfig:
    d = cleanup_mod.CleanupConfig()
    return cleanup_mod.CleanupConfig(
        deblur=bool(options.get("deblur", d.deblur)),
        min_smear_px=float(options.get("deblurMinSmear", d.min_smear_px)),
        residual=float(options.get("deblurResidual", d.residual)),
        tv_off=bool(options.get("tvOff", d.tv_off)),
        windows=bool(options.get("windows", d.windows)),
    )


def remaster(mesh: scene.Mesh, capture, options: dict, services: Services, device: str, report, log=print, layout: Layout | None = None) -> tuple[scene.Mesh, dict]:
    """The stages, in order. `report(stage, progress, message)`. `layout`: the room layout (build 13
    on), for what needs to know where the TVs and windows are."""
    stats: dict = {"photos": len(capture.cameras), "triangles": int(len(mesh.faces))}
    layout = layout or Layout()
    stats["layout"] = not layout.empty
    cfg = config_from(options)
    clean_cfg = cleanup_config(options)
    sharpened: dict = {}
    if services.cleaner is not None and clean_cfg.deblur:
        report("cleanup", 0.0, "sharpening the smeared photos")
        try:
            sharpened = cleanup_mod.sharpen_photos(capture, services.cleaner, clean_cfg, cfg.long_side, log=log)
            stats["photosSharpened"] = len(sharpened)
        except Exception as e:  # the skins learn from the photos as they are
            traceback.print_exc()
            stats["cleanupError"] = f"{type(e).__name__}: {e}"[:200]
            sharpened = {}
    quiet = cleanup_mod.screen_faces(mesh, layout.objects_of("television")) if clean_cfg.tv_off else None
    disagree = None
    if services.depth is not None and options.get("depth", True):
        report("depth", 0.0, "measuring the photos' depth")
        try:
            disagree = depth_mod.disagreements(mesh, capture, services.depth, depth_mod.DepthConfig(), log=log)
            stats["depthDisagreeShare"] = round(sum(int(m.sum()) for m in disagree.values()) / max(1, sum(m.size for m in disagree.values())), 4)
        except Exception as e:  # the skins learn without it
            traceback.print_exc()
            stats["depthError"] = f"{type(e).__name__}: {e}"[:200]
            disagree = None
    report("skins", 0.0, "lining up the photos with the model")
    views = skins.prepare_photos(
        mesh, capture, cfg, device=device, log=log, photos=sharpened, residual=clean_cfg.residual, quiet_faces=quiet, disagree=disagree
    )
    report("skins", 0.02, f"{len(views)} photos")
    extra = None
    if services.fixer is not None and options.get("fixerViews", True):
        d = fixviews.FixerViewsConfig()
        fix_cfg = fixviews.FixerViewsConfig(
            rounds=int(options.get("fixerRounds", d.rounds)),
            views=int(options.get("fixerViewCount", d.views)),
            width=int(options.get("fixerWidth", d.width)),
            height=int(options.get("fixerHeight", d.height)),
            weight=float(options.get("fixerWeight", d.weight)),
            share=float(options.get("fixerShare", d.share)),
            tone_lock=float(options.get("fixerToneLock", d.tone_lock)),
        )
        extra = fixviews.fixer_views(mesh, capture, cfg, fix_cfg, services.fixer, device=device, log=log)
        prepare = services.fixer.prepare if hasattr(services.fixer, "prepare") else None
        if prepare:
            prepare()  # its GPU starts while the skins train
    result = skins.train(mesh, views, cfg, device=device, log=log, progress=lambda p: report("skins", 0.02 + 0.9 * p, ""), extra=extra)
    stats.update(result.stats)
    out = result.mesh
    if not layout.empty:
        out, tidy_stats = cleanup_mod.tidy_skins(out, layout, clean_cfg, log=log)
        stats.update(tidy_stats)
    if options.get("fill", True):
        report("fill", 0.93, "filling in what no photo saw")
        try:
            painted = fill_mod.painted_from_photos(out, capture.seeds_xyz, capture.seed_spacing)
            out, fill_stats = fill_mod.fill(out, result.seen, services.inpainter, log=log, painted=painted)
            stats.update(fill_stats)
        except Exception as e:  # the skins stand without it
            traceback.print_exc()
            stats["fillError"] = f"{type(e).__name__}: {e}"[:200]
    return out, stats


def run_job(payload: dict, secret: str, workdir: str | Path = "/tmp/atrium-remaster", services: Services | None = None, device: str = "cuda") -> dict:
    services = services or Services()
    reporter = Reporter(payload["callback"], secret)
    work = Path(workdir) / str(payload["jobId"])
    shutil.rmtree(work, ignore_errors=True)
    capture_dir = work / "capture"
    capture_dir.mkdir(parents=True)
    try:
        started = time.time()
        reporter.progress("downloading", 0, f"{len(payload['files'])} files", force=True)
        received = download(payload["files"], capture_dir)
        model_path = work / "painted.glb"
        received += fetch(payload["model"]["url"], model_path)
        capture = load(capture_dir)
        layout = layout_mod.load(capture_dir)
        mesh = scene.from_model(glb.read(model_path.read_bytes()))
        if not mesh.atlases:
            raise ValueError("the model has no photos painted on it (a photo scan is needed)")
        share = photos_match(mesh, capture)
        if share < 0.5:
            raise ValueError(f"the photos don't match this model ({share:.0%} of their pixels land on it): was the scan sent again since?")
        options = payload.get("options") or {}

        def report(stage: str, value: float, message: str) -> None:
            reporter.progress(stage, value, message)

        out, stats = remaster(mesh, capture, options, services, device, report, layout=layout)
        reporter.progress("uploading", 1, "", force=True)
        out_path = work / "remastered.glb"
        out_path.write_bytes(glb.write(scene.to_model(out, quality=int(options.get("jpegQuality", 90)))))
        stats.update(
            {
                "modelMB": round(out_path.stat().st_size / 1e6, 1),
                "downloadMB": round(received / 1e6, 1),
                "photosOnModel": round(share, 3),
                "totalSeconds": round(time.time() - started, 1),
            }
        )
        answer = reporter.send({"event": "upload", "files": [{"name": "model.glb", "bytes": out_path.stat().st_size}], "stats": stats})
        targets = {t.get("name"): t for t in answer.get("targets", [])}
        if "model.glb" not in targets or not targets["model.glb"].get("url"):
            raise RuntimeError(f"no upload target: {answer}")
        upload(targets["model.glb"], out_path)
        reporter.send({"event": "done", "modelUrl": targets["model.glb"]["assetUrl"], "stats": stats})
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
