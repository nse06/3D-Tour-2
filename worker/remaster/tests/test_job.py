"""The remaster job end to end against a stand-in site: download, rebuild, upload, report."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

from atrium_remaster import glb, job, scene

from . import room

SECRET = "s" * 24


class Site:
    """Serves the capture and the painted model, takes reports and uploads."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.events: list[dict] = []
        self.uploads: dict[str, bytes] = {}
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                path = site.folder / self.path.lstrip("/")
                if not path.is_file():
                    self.send_response(404)
                    self.end_headers()
                    return
                data = path.read_bytes()
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_PUT(self):
                size = int(self.headers["content-length"])
                site.uploads[self.path] = self.rfile.read(size)
                self.send_response(200)
                self.end_headers()

            def do_POST(self):
                assert self.headers["authorization"] == f"Bearer {SECRET}"
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                site.events.append(body)
                answer = {}
                if body["event"] == "upload":
                    answer = {"targets": [{"name": f["name"], "url": f"{site.base}/up/{f['name']}", "method": "PUT", "headers": {}, "assetUrl": f"{site.base}/assets/{f['name']}"} for f in body["files"]]}
                data = json.dumps(answer).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def payload(self, options=None):
        cap = self.folder / "capture"
        files = [{"name": str(p.relative_to(cap)), "url": f"{self.base}/capture/{p.relative_to(cap)}"} for p in sorted(cap.rglob("*")) if p.is_file()]
        return {"jobId": "job-1", "callback": f"{self.base}/callback", "files": files, "model": {"url": f"{self.base}/model.glb"}, "options": options or {}}


FAST = {"steps": 60, "batch": 4, "tile": 256, "levels": 3, "maxMip": 3, "spotFace": 32, "spotLongSide": 160}


def test_a_job_downloads_rebuilds_uploads_and_reports(tmp_path, capsys):
    room.write(tmp_path / "site")
    site = Site(tmp_path / "site")
    stats = job.run_job(site.payload(FAST), SECRET, workdir=tmp_path / "work", device="cpu")
    logged = [line for line in capsys.readouterr().out.splitlines() if line.startswith("remaster done: ")]
    assert len(logged) == 1 and json.loads(logged[0].split(": ", 1)[1])["totalSeconds"] == stats["totalSeconds"], "the numbers, in the log"
    kinds = [e["event"] for e in site.events]
    assert kinds[0] == "progress" and kinds[-3:] == ["upload", "upload", "done"] and "failed" not in kinds
    spots_upload, model_upload, done = site.events[-3:]
    assert [f["name"] for f in model_upload["files"]] == ["model.glb"]
    assert done["modelUrl"].endswith("/assets/model.glb") and done["stats"]["photos"] == 16
    model = scene.from_model(glb.read(site.uploads["/up/model.glb"]))
    assert model.atlases[0].shape == (1024, 1024, 3) and model.extras["atrium"]["schema"] == "atrium.scan-manifest/v1"
    assert stats["photosOnModel"] > 0.9 and not (tmp_path / "work" / "job-1").exists()
    assert "lightError" not in stats and stats["lightExposure"] > 0, "the lighting ran, on the skins and the spots"
    stages = stats["stageSeconds"]
    assert {"downloading", "skins", "light", "spots", "uploading"} <= set(stages), stages
    assert abs(sum(stages.values()) - stats["totalSeconds"]) < 2, "every second is in some stage"
    # The photo spots: their pictures uploaded first, listed in the model.
    listed = model.extras["atriumSpots"]["spots"]
    assert stats["spots"] == len(listed) == len(spots_upload["files"]) > 0 and model.extras["atriumSpots"]["face"] == 32
    for k, spot in enumerate(listed):
        assert spot["image"].endswith(f"/assets/spot-{k:03d}.jpg") and len(spot["position"]) == 3
        sheet = site.uploads[f"/up/spot-{k:03d}.jpg"]
        assert sheet[:2] == b"\xff\xd8"


def test_photos_of_another_scan_are_turned_away(tmp_path):
    truth = room.write(tmp_path / "site")
    # The model moved 5 m away: the photos see none of it.
    mesh = truth["mesh"]
    moved = scene.Mesh(mesh.vertices + np.float32([5, 0, 0]), mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, mesh.atlases, mesh.extras)
    (tmp_path / "site" / "model.glb").write_bytes(glb.write(scene.to_model(moved)))
    site = Site(tmp_path / "site")
    with pytest.raises(ValueError, match="don't match"):
        job.run_job(site.payload(FAST), SECRET, workdir=tmp_path / "work", device="cpu")
    assert site.events[-1]["event"] == "failed" and "don't match" in site.events[-1]["message"]
