"""GLB files in and out: the painted model the phone made (docs/iphone-capture.md §2.2, §2.4) and the
remastered model the viewer loads in its place.

Only what Atrium models use: triangle meshes with positions and one set of UVs, materials with a base
color (a texture or a factor), unlit or not, and the scene's extras (the scan manifest). Node
transforms are applied on reading, so every primitive comes out in the model's frame.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field

import numpy as np

MAGIC = 0x46546C67  # "glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
# What the phone's photo models use for their atlases (GLTF.swift): linear filtering, mipmaps, clamped.
CLAMPED = {"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}


@dataclass
class Primitive:
    positions: np.ndarray  # (V, 3) float32, in the model's frame
    faces: np.ndarray  # (F, 3) int64
    uvs: np.ndarray | None = None  # (V, 2) float32, glTF's: v down from the image's top
    material: int | None = None
    name: str = ""


@dataclass
class Material:
    name: str
    image: int | None = None  # base color texture's image
    color: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)  # base color factor (linear)
    unlit: bool = True


@dataclass
class Image:
    data: bytes
    mime: str  # "image/jpeg" or "image/png"
    name: str = ""


@dataclass
class Model:
    primitives: list[Primitive] = field(default_factory=list)
    materials: list[Material] = field(default_factory=list)
    images: list[Image] = field(default_factory=list)
    # scenes[0].extras: the scan manifest ("atrium") and the frame it was built in ("atriumCapture").
    extras: dict = field(default_factory=dict)
    generator: str = "Atrium remaster"


def _node_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.asarray(node["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in node:
        m = np.diag([*node["scale"], 1.0]) @ m
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        r = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ]
        )
        rot = np.eye(4)
        rot[:3, :3] = r
        m = rot @ m
    if "translation" in node:
        t = np.eye(4)
        t[:3, 3] = node["translation"]
        m = t @ m
    return m


def read(data: bytes) -> Model:
    if len(data) < 20:
        raise ValueError("not a GLB file")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != MAGIC or version != 2:
        raise ValueError("not a glTF 2.0 binary")
    offset, doc, bin_chunk = 12, None, b""
    while offset + 8 <= min(length, len(data)):
        size, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + size]
        if kind == JSON_CHUNK:
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == BIN_CHUNK:
            bin_chunk = chunk
        offset += 8 + size + (-size % 4)
    if doc is None:
        raise ValueError("GLB without a JSON chunk")

    views = doc.get("bufferViews", [])

    def view_bytes(index: int) -> tuple[bytes, int, int]:
        v = views[index]
        if v.get("buffer", 0) != 0:
            raise ValueError("only the GLB's own buffer is supported")
        start = v.get("byteOffset", 0)
        return bin_chunk, start, v.get("byteStride", 0)

    def accessor(index: int) -> np.ndarray:
        a = doc["accessors"][index]
        dtype = np.dtype(DTYPES[a["componentType"]])
        n = COMPONENTS[a["type"]]
        count = a["count"]
        if "bufferView" not in a:
            return np.zeros((count, n), dtype=dtype)
        raw, start, stride = view_bytes(a["bufferView"])
        start += a.get("byteOffset", 0)
        item = dtype.itemsize * n
        if stride and stride != item:
            rows = np.ndarray((count,), dtype=np.dtype((np.void, item)), buffer=raw, offset=start, strides=(stride,))
            out = np.frombuffer(rows.tobytes(), dtype=dtype).reshape(count, n)
        else:
            out = np.frombuffer(raw, dtype=dtype, count=count * n, offset=start).reshape(count, n)
        if a.get("normalized") and dtype.kind in "iu":
            out = out.astype(np.float32) / float(np.iinfo(dtype).max)
        return out

    model = Model()
    for i, im in enumerate(doc.get("images", [])):
        if "bufferView" not in im:
            raise ValueError("images must be stored in the GLB")
        raw, start, _ = view_bytes(im["bufferView"])
        size = views[im["bufferView"]]["byteLength"]
        model.images.append(Image(bytes(raw[start : start + size]), im.get("mimeType", "image/png"), im.get("name", f"image{i}")))
    textures = doc.get("textures", [])
    for m in doc.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        image = None
        if "baseColorTexture" in pbr:
            image = textures[pbr["baseColorTexture"]["index"]].get("source")
        color = tuple(float(c) for c in pbr.get("baseColorFactor", [1, 1, 1, 1]))
        model.materials.append(Material(m.get("name", ""), image, color, "KHR_materials_unlit" in m.get("extensions", {})))

    scenes = doc.get("scenes", [])
    scene = scenes[doc.get("scene", 0)] if scenes else {"nodes": list(range(len(doc.get("nodes", []))))}
    model.extras = dict(scene.get("extras", {}))
    nodes = doc.get("nodes", [])

    def visit(index: int, parent: np.ndarray) -> None:
        node = nodes[index]
        world = parent @ _node_matrix(node)
        if "mesh" in node:
            mesh = doc["meshes"][node["mesh"]]
            for p in mesh["primitives"]:
                if p.get("mode", 4) != 4:
                    continue
                pos = accessor(p["attributes"]["POSITION"]).astype(np.float64)
                pos = pos @ world[:3, :3].T + world[:3, 3]
                if "indices" in p:
                    faces = accessor(p["indices"]).reshape(-1, 3).astype(np.int64)
                else:
                    faces = np.arange(len(pos), dtype=np.int64).reshape(-1, 3)
                if np.linalg.det(world[:3, :3]) < 0:
                    faces = faces[:, ::-1].copy()
                uvs = accessor(p["attributes"]["TEXCOORD_0"]).astype(np.float32) if "TEXCOORD_0" in p["attributes"] else None
                model.primitives.append(Primitive(pos.astype(np.float32), faces, uvs, p.get("material"), mesh.get("name", "")))
        for child in node.get("children", []):
            visit(child, world)

    for index in scene.get("nodes", []):
        visit(index, np.eye(4))
    return model


def write(model: Model) -> bytes:
    """The model as a GLB the viewer loads (unlit photo materials as the phone writes them, GLTF.swift)."""
    bin_parts: list[bytes] = []
    size = 0
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(blob: bytes, target: int | None = None) -> int:
        nonlocal size
        pad = -size % 4
        if pad:
            bin_parts.append(b"\0" * pad)
            size += pad
        view = {"buffer": 0, "byteOffset": size, "byteLength": len(blob)}
        if target is not None:
            view["target"] = target
        bin_parts.append(blob)
        size += len(blob)
        views.append(view)
        return len(views) - 1

    def floats(values: np.ndarray, kind: str, bounds: bool = False) -> int:
        values = np.ascontiguousarray(values, dtype="<f4")
        entry = {"bufferView": add_view(values.tobytes(), 34962), "componentType": 5126, "count": len(values), "type": kind}
        if bounds and len(values):
            entry["min"] = [float(v) for v in values.min(0)]
            entry["max"] = [float(v) for v in values.max(0)]
        accessors.append(entry)
        return len(accessors) - 1

    def indices(faces: np.ndarray) -> int:
        flat = np.ascontiguousarray(faces.reshape(-1), dtype="<u4")
        accessors.append({"bufferView": add_view(flat.tobytes(), 34963), "componentType": 5125, "count": len(flat), "type": "SCALAR"})
        return len(accessors) - 1

    images = [{"bufferView": add_view(im.data), "mimeType": im.mime, "name": im.name or f"image{i}"} for i, im in enumerate(model.images)]
    materials = []
    for m in model.materials:
        pbr: dict = {"baseColorFactor": [float(c) for c in m.color], "metallicFactor": 0.0, "roughnessFactor": 1.0}
        if m.image is not None:
            pbr["baseColorTexture"] = {"index": m.image}
        entry: dict = {"name": m.name, "pbrMetallicRoughness": pbr}
        if m.unlit:
            entry["extensions"] = {"KHR_materials_unlit": {}}
        materials.append(entry)
    meshes, nodes = [], []
    for p in model.primitives:
        if not len(p.faces):
            continue
        attributes = {"POSITION": floats(p.positions, "VEC3", bounds=True)}
        if p.uvs is not None:
            attributes["TEXCOORD_0"] = floats(p.uvs, "VEC2")
        primitive: dict = {"attributes": attributes, "indices": indices(p.faces), "mode": 4}
        if p.material is not None:
            primitive["material"] = p.material
        meshes.append({"name": p.name, "primitives": [primitive]})
        nodes.append({"name": p.name, "mesh": len(meshes) - 1})

    doc: dict = {
        "asset": {"version": "2.0", "generator": model.generator},
        "scene": 0,
        "scenes": [{"name": "Scan", "nodes": list(range(len(nodes))), "extras": model.extras}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
    }
    if images:
        doc["images"] = images
        doc["samplers"] = [CLAMPED]
        doc["textures"] = [{"source": i, "sampler": 0} for i in range(len(images))]
    if any(m.unlit for m in model.materials):
        doc["extensionsUsed"] = ["KHR_materials_unlit"]
    pad = -size % 4
    if pad:
        bin_parts.append(b"\0" * pad)
        size += pad
    doc["buffers"] = [{"byteLength": size}]
    text = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    body = b"".join(bin_parts)
    total = 12 + 8 + len(text) + 8 + len(body)
    return struct.pack("<III", MAGIC, 2, total) + struct.pack("<II", len(text), JSON_CHUNK) + text + struct.pack("<II", len(body), BIN_CHUNK) + body


def triangle_area(positions: np.ndarray, faces: np.ndarray) -> np.ndarray:
    a, b, c = positions[faces[:, 0]], positions[faces[:, 1]], positions[faces[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
