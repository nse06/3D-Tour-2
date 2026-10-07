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
import struct
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
ROUTE = re.compile(r"^/api/capture/sessions/([^/]+)(/uploads|/complete)?$")


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

        def do_GET(self):
            kind = self.session()
            if kind == "":
                self.reply(200, {"property": {"id": "p1", "addressLine": "1 Test Street", "city": "Testville", "state": "IL"}, "expiresAt": "2099-01-01T00:00:00.000Z"})
            elif kind is not None:
                self.reply(404, {"error": "not found"})

        def do_PUT(self):
            name = self.path.split("?")[0].removeprefix("/upload/")
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
                }
                state.out.mkdir(parents=True, exist_ok=True)
                (state.out / "results.json").write_text(json.dumps(result, indent=2))
                (state.out / "scan.glb").write_bytes(state.files[asset])
                return self.reply(200, {**{k: result[k] for k in ("ok", "rooms", "floors")}, "propertyUrl": "http://127.0.0.1/dashboard/properties/p1", "previewUrl": "http://127.0.0.1/dashboard/properties/p1/preview"})
            self.reply(404, {"error": "not found"})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--out", type=Path, default=Path("results"))
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(State(args.out)))
    print(f"mock Atrium server on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
