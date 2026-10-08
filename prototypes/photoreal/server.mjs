// Static server for the photoreal prototype: /three/* → the app's three.js, everything else from this folder.
// node server.mjs <port>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.dirname(new URL(import.meta.url).pathname);
const three = path.resolve(root, "../../node_modules/three");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".ply": "application/octet-stream", ".splat": "application/octet-stream", ".bin": "application/octet-stream", ".wasm": "application/wasm" };
const port = Number(process.argv[2] || 8931);
http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = url.startsWith("/three/") ? path.join(three, url.slice(7)) : path.join(root, url.endsWith("/") ? url + "index.html" : url);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("not found " + url); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, "127.0.0.1", () => console.log("serving on", port));
