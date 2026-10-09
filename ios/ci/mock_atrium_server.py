#!/usr/bin/env python3
"""A stand-in for the Atrium web app's phone endpoints (docs/iphone-capture.md §3.2).

Used by the simulator smoke test in .github/workflows/ios.yml: the app pairs with
it, uploads a scan and completes it; this server checks what arrived (a valid
glTF binary whose embedded manifest matches the one sent) and writes
results.json into --out.

    python3 mock_atrium_server.py --port 8765 --out results/
"""

import argparse
import json
import re
import socketserver
import struct
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
ROUTE = re.compile(r"^/api/capture/sessions/([^/]+)(/uploads|/complete|/photoreal(?:/[\w-]+)?)?$")
# What the real server accepts (src/lib/photoreal.ts).
PHOTOREAL_FILE = re.compile(r"^(cameras\.json|seeds\.ply|frames/[A-Za-z0-9_-]+\.(jpg|jpeg|png)|masks/[A-Za-z0-9_-]+\.png)$")


def check_glb(data: bytes) -> dict:
    if len(data) < 20:
        raise ValueError("model is too small")
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise ValueError(f"not a glTF 2.0 binary (magic={magic!r} version={version} length={length}/{len(data)})")
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("first chunk is not JSON")
    gltf = json.loads(data[20 : 20 + json_length])
    manifest = gltf["scenes"][0]["extras"]["atrium"]
    return {"meshes": len(gltf.get("meshes", [])), "materials": len(gltf.get("materials", [])), "manifest": manifest}


class State:
    def __init__(self, out: Path):
        self.out = out
        self.files: dict[str, bytes] = {}
        self.counter = 0
        self.last_asset: str | None = None
        # Photoreal jobs: declared sizes, what arrived (sizes; cameras.json and seeds.ply kept).
        self.jobs: dict[str, dict] = {}


def check_photoreal(job: dict) -> dict:
    declared, arrived = job["declared"], job["arrived"]
    missing = [n for n in declared if arrived.get(n) != declared[n]]
    if missing:
        raise ValueError(f"{len(missing)} of {len(declared)} files missing or the wrong size, e.g. {missing[:3]}")
    cameras = json.loads(job["cameras"])
    if cameras.get("format") != "atrium-photoreal/1":
        raise ValueError(f"cameras.json format {cameras.get('format')!r}")
    photos = [f["file"] for f in cameras["frames"] if f["file"] in arrived]
    if len(photos) < 10 or any(len(f["pose"]) != 16 for f in cameras["frames"]):
        raise ValueError(f"{len(photos)} photos arrived of the {len(cameras['frames'])} cameras.json lists")
    seeds = job["seeds"]
    end = seeds.index(b"end_header\n") + len(b"end_header\n")
    header = seeds[:end].decode()
    count = int(re.search(r"element vertex (\d+)", header).group(1))
    if "binary_little_endian" not in header or len(seeds) != end + 27 * count:
        raise ValueError("seeds.ply is cut short")
    return {
        "ok": True,
        "files": len(declared),
        "bytes": sum(declared.values()),
        "frames": len(photos),
        "cameras": len(cameras["frames"]),
        "masks": sum(1 for n in declared if n.startswith("masks/")),
        "seeds": count,
        "assetUrl": job["assetUrl"],
    }


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            sys.stderr.write("mock-atrium: " + fmt % args + "\n")

        def reply(self, status: int, body: dict):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def body(self) -> bytes:
            return self.rfile.read(int(self.headers.get("Content-Length") or 0))

        def session(self):
            m = ROUTE.match(self.path)
            if not m or not TOKEN.match(m.group(1)):
                self.reply(404, {"error": "This pairing code has expired."})
                return None
            return m.group(2) or ""

        def job_reply(self, job: dict, status: int = 200):
            self.reply(status, {
                "id": job["id"], "status": job["status"], "stage": None, "progress": 0,
                "message": job.get("message"), "files": len(job["declared"]), "bytes": sum(job["declared"].values()),
                "splatUrl": None, "createdAt": "2026-01-01T00:00:00.000Z", "startedAt": None, "finishedAt": None, "stats": None,
            })

        def do_GET(self):
            kind = self.session()
            if kind and kind.startswith("/photoreal/"):
                job = state.jobs.get(kind.removeprefix("/photoreal/"))
                return self.job_reply(job) if job else self.reply(404, {"error": "No such photoreal job."})
            if kind == "":
                self.reply(200, {"property": {"id": "p1", "addressLine": "1 Test Street", "city": "Testville", "state": "IL"}, "expiresAt": "2099-01-01T00:00:00.000Z"})
            elif kind is not None:
                self.reply(404, {"error": "not found"})

        def do_PUT(self):
            path = self.path.split("?")[0]
            if path.startswith("/photoreal-upload/"):
                job_id, _, name = path.removeprefix("/photoreal-upload/").partition("/")
                job = state.jobs.get(job_id)
                if not job or name not in job["declared"]:
                    return self.reply(403, {"error": "bad photoreal upload link"})
                data = self.body()
                job["arrived"][name] = len(data)
                if name == "cameras.json":
                    job["cameras"] = data
                elif name == "seeds.ply":
                    job["seeds"] = data
                return self.reply(200, {"ok": True})
            name = path.removeprefix("/upload/")
            if not re.match(r"^(capture|package)-\d+\.(glb|zip)$", name):
                return self.reply(400, {"error": "bad upload path"})
            state.files[name] = self.body()
            self.reply(200, {"ok": True})

        def do_POST(self):
            kind = self.session()
            if kind is None:
                return
            try:
                data = json.loads(self.body() or b"{}")
            except json.JSONDecodeError:
                return self.reply(400, {"error": "Expected JSON."})
            if kind == "/uploads":
                if data.get("kind") not in ("capture", "package") or not data.get("filename") or not data.get("size"):
                    return self.reply(400, {"error": "bad upload request"})
                state.counter += 1
                ext = "glb" if data["kind"] == "capture" else "zip"
                name = f"{data['kind']}-{state.counter}.{ext}"
                # Relative URL, like the real server in local mode.
                return self.reply(200, {"method": "PUT", "url": f"/upload/{name}?sig=test", "headers": {"content-type": "application/octet-stream"}, "assetUrl": f"/assets/{name}"})
            if kind == "/photoreal":
                files = data.get("files")
                if not isinstance(files, list) or not files:
                    return self.reply(400, {"error": "Expected the list of files to upload."})
                declared = {}
                for f in files:
                    name, size = str(f.get("name", "")), f.get("size")
                    if not PHOTOREAL_FILE.match(name) or name in declared or not isinstance(size, int) or size <= 0:
                        return self.reply(400, {"error": f"Unexpected file: {name[:80]}"})
                    declared[name] = size
                if "cameras.json" not in declared or "seeds.ply" not in declared:
                    return self.reply(400, {"error": "cameras.json and seeds.ply are required."})
                if sum(1 for n in declared if n.startswith("frames/")) < 10:
                    return self.reply(400, {"error": "A photoreal walkthrough needs the scan's photos (at least 10)."})
                if state.last_asset is None:
                    return self.reply(409, {"error": "Send the scan to Atrium first, then make it photoreal."})
                if data.get("assetUrl") is not None and data["assetUrl"] != state.last_asset:
                    return self.reply(409, {"error": "The listing shows a different scan now."})
                job_id = f"job-{len(state.jobs) + 1}"
                state.jobs[job_id] = {"id": job_id, "status": "uploading", "declared": declared, "arrived": {}, "assetUrl": data.get("assetUrl")}
                uploads = [{"name": n, "method": "PUT", "url": f"/photoreal-upload/{job_id}/{n}?sig=test", "headers": {"content-type": "application/octet-stream"}} for n in declared]
                return self.reply(200, {"jobId": job_id, "uploads": uploads})
            if kind.startswith("/photoreal/"):
                job = state.jobs.get(kind.removeprefix("/photoreal/"))
                if not job:
                    return self.reply(404, {"error": "No such photoreal job."})
                try:
                    result = check_photoreal(job)
                except Exception as e:  # noqa: BLE001 — report any malformed upload
                    return self.reply(400, {"error": f"Photoreal upload incomplete: {e}"})
                state.out.mkdir(parents=True, exist_ok=True)
                (state.out / "photoreal.json").write_text(json.dumps(result, indent=2))
                job.update(status="queued", message="Waiting for the GPU (mock server).")
                return self.job_reply(job)
            if kind == "/complete":
                asset = str(data.get("assetUrl", "")).removeprefix("/assets/")
                if asset not in state.files:
                    return self.reply(400, {"error": "The 3D model didn't finish uploading."})
                try:
                    glb = check_glb(state.files[asset])
                except Exception as e:  # noqa: BLE001 — report any malformed upload
                    return self.reply(422, {"error": f"Invalid model: {e}"})
                manifest = data.get("manifest") or {}
                if manifest.get("schema") != "atrium.scan-manifest/v1" or not manifest.get("rooms"):
                    return self.reply(422, {"error": "The scan is missing its room data."})
                if glb["manifest"] != manifest:
                    return self.reply(422, {"error": "The manifest sent does not match the model's embedded manifest."})
                result = {
                    "ok": True,
                    "rooms": len(manifest["rooms"]),
                    "floors": len(manifest.get("floors", [])),
                    "links": len(manifest.get("links", [])),
                    "glbBytes": len(state.files[asset]),
                    "meshes": glb["meshes"],
                    "packageUrl": data.get("packageUrl"),
                    "cleanAssetUrl": data.get("cleanAssetUrl"),
                }
                state.out.mkdir(parents=True, exist_ok=True)
                (state.out / "results.json").write_text(json.dumps(result, indent=2))
                (state.out / "scan.glb").write_bytes(state.files[asset])
                state.last_asset = data.get("assetUrl")
                return self.reply(200, {**{k: result[k] for k in ("ok", "rooms", "floors")}, "propertyUrl": "http://127.0.0.1/dashboard/properties/p1", "previewUrl": "http://127.0.0.1/dashboard/properties/p1/preview"})
            self.reply(404, {"error": "not found"})

    return Handler


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer looks up the host's name here, before it listens; on CI runners that lookup
        # can take many seconds, refusing the app's first requests.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--out", type=Path, default=Path("results"))
    args = parser.parse_args()
    server = Server(("127.0.0.1", args.port), make_handler(State(args.out)))
    print(f"mock Atrium server on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
