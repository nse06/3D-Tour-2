"""The photoreal worker on a tiny scene, on the CPU: conventions, the .spz file, training, and the
job protocol with the Atrium site.  Run: cd worker/photoreal && python -m pytest tests -q"""

import http.server
import json
import threading
from pathlib import Path

import numpy as np
import torch

from atrium_photoreal import spz
from atrium_photoreal.capture import load, load_photo
from atrium_photoreal.job import run_job, write_splats
from atrium_photoreal.render import psnr, rasterize
from atrium_photoreal.train import TrainConfig, quats_from_normals, train

from . import scene


def test_cameras_follow_the_opencv_convention(tmp_path):
    """Seeds projected the way gsplat projects (OpenCV: x right, y down, looking along +z) land on
    pixels of their own color."""
    capture = load(scene.write(tmp_path / "capture"))
    assert len(capture.cameras) == 12
    errors = []
    for cam in capture.cameras:
        rgb, K, _ = load_photo(cam, 64)
        w2c = np.linalg.inv(cam.camtoworld)
        X = capture.seeds_xyz @ w2c[:3, :3].T + w2c[:3, 3]
        front = X[:, 2] > 0.1
        u = K[0, 0] * X[front, 0] / X[front, 2] + K[0, 2]
        v = K[1, 1] * X[front, 1] / X[front, 2] + K[1, 2]
        inside = (u >= 0) & (u < rgb.shape[1]) & (v >= 0) & (v < rgb.shape[0])
        got = rgb[v[inside].astype(int), u[inside].astype(int)] / 255
        errors.append(np.abs(got - capture.seeds_rgb[front][inside] / 255).max(1))
    e = np.concatenate(errors)
    assert len(e) > 500
    assert np.median(e) < 0.06, np.median(e)


def test_seed_discs_lie_flat_on_their_surface():
    normals = np.array([[0, 1, 0], [1, 0, 0], [0, 0, -1], [0.6, 0.0, 0.8]], dtype=np.float64)
    q = quats_from_normals(normals)
    w, x, y, z = q.T
    # The rotation's third column: where the disc's thin axis (+z) points.
    third = np.stack([2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)], 1)
    assert np.allclose(third, normals, atol=1e-6)


def test_spz_round_trip(tmp_path):
    rng = np.random.default_rng(1)
    n = 500
    means = rng.uniform(-5, 5, (n, 3)).astype(np.float32)
    scales = rng.uniform(-6, -1, (n, 3)).astype(np.float32)
    quats = rng.normal(size=(n, 4)).astype(np.float32)
    opacities = rng.uniform(-2, 4, n).astype(np.float32)
    sh = rng.uniform(-0.4, 0.4, (n, 16, 3)).astype(np.float32)
    written = spz.write(tmp_path / "s.spz", means, scales, quats, opacities, sh, 3, min_opacity=0)
    back = spz.read(tmp_path / "s.spz")
    assert written["splats"] == n and back["sh_degree"] == 3
    assert np.abs(back["means"] - means).max() < 1 / 4096
    assert np.abs(back["log_scales"] - scales).max() < 1 / 16
    assert np.abs(back["opacity"] - 1 / (1 + np.exp(-opacities))).max() < 1 / 255
    assert np.abs(back["sh0"] - sh[:, 0]).max() < 0.5 / 255 / 0.15 + 1e-6
    assert np.abs(back["sh_rest"] - sh[:, 1:]).max() < 1 / 128
    unit = quats / np.linalg.norm(quats, axis=1, keepdims=True)
    # q and -q are the same rotation.
    error = np.minimum(np.abs(back["quats_wxyz"] - unit).max(1), np.abs(back["quats_wxyz"] + unit).max(1))
    assert error.max() < 2e-3, "smallest-three keeps rotations to about a tenth of a degree"


def test_training_learns_the_scene_and_leaves_people_out(tmp_path):
    folder = scene.write(tmp_path / "capture", brightness_spread=0.15, people_on=(3, 7))
    capture = load(folder)
    # Gray seeds: everything about the floor's look has to come from the photos.
    capture.seeds_rgb[:] = 128
    # A short run: colors learn faster than gsplat's defaults so 300 steps get somewhere.
    cfg = TrainConfig(steps=300, long_side=64, sh_degree=1, sh_degree_interval=100, sh0_lr=0.02, holdout_every=0, progress_every=50)
    cams = capture.cameras
    before = []
    for cam in cams[:4]:
        rgb, K, _ = load_photo(cam, 64)
        from atrium_photoreal.train import init_splats

        splats = init_splats(capture, cfg, torch.device("cpu"), np.random.default_rng(0))
        image, _, _ = rasterize(splats, torch.linalg.inv(torch.tensor(cam.camtoworld, dtype=torch.float32)), torch.tensor(K, dtype=torch.float32), 64, 48, 0)
        before.append(psnr(image[0].detach().clamp(0, 1), torch.from_numpy(rgb).float() / 255))
    result = train(capture, cfg, device="cpu", log=lambda m: None)
    assert result.stats["trainPsnr"] > np.mean(before) + 6, (np.mean(before), result.stats)
    assert result.stats["trainPsnr"] > 22, result.stats

    # Where someone stood in photo 3, the splats show the floor, not the magenta block.
    cam = cams[3]
    rgb, K, people = load_photo(cam, 64)
    assert people is not None and people.sum() > 100
    pose = np.asarray(json.loads((folder / "cameras.json").read_text())["frames"][3]["pose"]).reshape(4, 4).T
    truth = scene.render(pose)
    with torch.no_grad():
        image, _, _ = rasterize(result.splats, torch.linalg.inv(torch.tensor(cam.camtoworld, dtype=torch.float32)), torch.tensor(K, dtype=torch.float32), 64, 48, 1)
    region = image[0].numpy()[18:38, 28:36]
    assert np.abs(region - truth[18:38, 28:36]).mean() < 0.12, np.abs(region - truth[18:38, 28:36]).mean()
    magenta = (region[..., 0] > 0.8) & (region[..., 1] < 0.3) & (region[..., 2] > 0.8)
    assert magenta.mean() < 0.05


def test_exposure_keeps_the_photos_average_look():
    """Per-photo gains and offsets average to none, so the splats' own colors are the photos' average
    (what the viewer shows), and a photo can't stray more than two stops."""
    from atrium_photoreal.train import Exposure

    exposure = Exposure(6)
    with torch.no_grad():
        exposure.log_gain.copy_(torch.randn(6, 3, generator=torch.Generator().manual_seed(0)) * 0.2 + 0.3)
        exposure.offset.copy_(torch.full((6, 3), 0.05))
    exposure.anchor()
    assert torch.allclose(exposure.log_gain.mean(0), torch.zeros(3), atol=1e-6)
    assert torch.allclose(exposure.offset.mean(0), torch.zeros(3), atol=1e-6)
    with torch.no_grad():
        exposure.log_gain[0] = 5.0
    exposure.anchor()
    assert float(exposure.log_gain.max()) <= np.log(4.0) + 1e-6
    image = torch.full((2, 2, 3), 0.5)
    assert torch.allclose(exposure(image, 3), image * torch.exp(exposure.log_gain[3]) + exposure.offset[3])


class _Site(http.server.BaseHTTPRequestHandler):
    """The Atrium site and its storage, as far as the worker sees them."""

    folder: Path
    events: list
    uploads: dict

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.folder / self.path.removeprefix("/files/")
        if not self.path.startswith("/files/") or not path.is_file():
            self.send_response(404)
            self.end_headers()
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.headers.get("authorization") != "Bearer test-secret":
            self.send_response(401)
            self.end_headers()
            return
        self.events.append(body)
        answer = {"ok": True}
        if body["event"] == "upload":
            host = f"http://127.0.0.1:{self.server.server_address[1]}"
            answer = {"url": f"{host}/upload/splats.spz", "method": "PUT", "headers": {"content-type": "application/octet-stream"}, "assetUrl": f"{host}/assets/splats.spz"}
        data = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        self.uploads[self.path] = self.rfile.read(int(self.headers["content-length"]))
        self.send_response(200)
        self.end_headers()


def test_a_job_downloads_trains_uploads_and_reports(tmp_path):
    folder = scene.write(tmp_path / "capture", cameras=6)
    _Site.folder, _Site.events, _Site.uploads = folder, [], {}
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        names = ["cameras.json", "seeds.ply", *[f"frames/{p.name}" for p in sorted((folder / "frames").iterdir())]]
        payload = {
            "jobId": "job-1",
            "callback": f"{host}/callback",
            "files": [{"name": n, "url": f"{host}/files/{n}"} for n in names],
            "options": {"steps": 40, "longSide": 64, "maxGaussians": 50_000},
        }
        stats = run_job(payload, secret="test-secret", workdir=tmp_path / "work")
    finally:
        server.shutdown()
    kinds = [e["event"] for e in _Site.events]
    assert kinds[0] == "progress" and _Site.events[0]["stage"] == "downloading"
    assert "upload" in kinds and kinds[-1] == "done", kinds
    done = _Site.events[-1]
    assert done["assetUrl"].endswith("/assets/splats.spz") and done["stats"]["steps"] == 40
    assert len(done["spots"]) == 6 and all(len(spot) == 5 for spot in done["spots"])
    uploaded = _Site.uploads["/upload/splats.spz"]
    (tmp_path / "got.spz").write_bytes(uploaded)
    assert spz.read(tmp_path / "got.spz")["means"].shape[0] == stats["splats"] > 1000
    assert not (tmp_path / "work" / "job-1").exists(), "the job cleans up after itself"


def test_a_failed_job_says_why(tmp_path):
    _Site.folder, _Site.events, _Site.uploads = tmp_path, [], {}
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        payload = {"jobId": "job-2", "callback": f"{host}/callback", "files": [{"name": "cameras.json", "url": f"{host}/files/missing.json"}]}
        try:
            run_job(payload, secret="test-secret", workdir=tmp_path / "work")
            raise AssertionError("the job should fail")
        except Exception:
            pass
    finally:
        server.shutdown()
    assert _Site.events[-1]["event"] == "failed" and "HTTP" in _Site.events[-1]["message"]


def test_splats_drop_view_dependent_color_to_fit_the_size_limit(tmp_path):
    rng = np.random.default_rng(0)
    n = 20_000
    splats = {
        "means": torch.from_numpy(rng.uniform(-3, 3, (n, 3)).astype(np.float32)),
        "scales": torch.full((n, 3), -4.0),
        "quats": torch.from_numpy(rng.normal(size=(n, 4)).astype(np.float32)),
        "opacities": torch.full((n,), 2.0),
        "sh0": torch.from_numpy(rng.normal(size=(n, 1, 3)).astype(np.float32)),
        "shN": torch.from_numpy(rng.normal(scale=0.1, size=(n, 15, 3)).astype(np.float32)),
    }
    full = write_splats(tmp_path / "full.spz", splats, 3, 10**9)
    assert full["shDegree"] == 3
    fitted = write_splats(tmp_path / "fitted.spz", splats, 3, full["bytes"] // 2)
    assert fitted["shDegree"] < 3 and fitted["bytes"] <= full["bytes"] // 2 and fitted["trainedShDegree"] == 3
    assert spz.read(tmp_path / "fitted.spz")["sh_degree"] == fitted["shDegree"]
