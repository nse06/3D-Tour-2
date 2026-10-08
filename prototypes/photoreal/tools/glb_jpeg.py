"""Re-encodes a .glb's PNG textures as JPEG (what the phone stores): python3 tools/glb_jpeg.py in.glb out.glb [quality]"""
import io
import json
import struct
import sys

from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
quality = int(sys.argv[3]) if len(sys.argv) > 3 else 88
data = open(src, "rb").read()
jlen = struct.unpack_from("<I", data, 12)[0]
gltf = json.loads(data[20:20 + jlen])
bin_off = 20 + jlen
blen = struct.unpack_from("<I", data, bin_off)[0]
blob = data[bin_off + 8:bin_off + 8 + blen]
views = gltf["bufferViews"]
chunks = [blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in views]
for img in gltf.get("images", []):
    if img.get("mimeType") != "image/png":
        continue
    png = Image.open(io.BytesIO(chunks[img["bufferView"]])).convert("RGB")
    out = io.BytesIO()
    png.save(out, "JPEG", quality=quality, optimize=True)
    chunks[img["bufferView"]] = out.getvalue()
    img["mimeType"] = "image/jpeg"
new_blob = b""
for v, c in zip(views, chunks):
    while len(new_blob) % 4:
        new_blob += b"\0"
    v["byteOffset"] = len(new_blob)
    v["byteLength"] = len(c)
    new_blob += c
while len(new_blob) % 4:
    new_blob += b"\0"
gltf["buffers"][0]["byteLength"] = len(new_blob)
js = json.dumps(gltf, separators=(",", ":")).encode()
while len(js) % 4:
    js += b" "
total = 12 + 8 + len(js) + 8 + len(new_blob)
out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<I", len(js)) + b"JSON" + js + struct.pack("<I", len(new_blob)) + b"BIN\0" + new_blob
open(dst, "wb").write(out)
print(f"{src}: {len(data) / 1e6:.1f} MB → {dst}: {len(out) / 1e6:.1f} MB")
