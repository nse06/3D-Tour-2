#!/usr/bin/env python3
"""Turns Apple's RoomPlan multi-room sample into a scan as Atrium Capture builds
1–2 saved it, for the simulator rebuild test in .github/workflows/ios.yml.

RoomPlan reports every room of a multi-room scan relative to where the phone
was when that room's scan started. Apple's sample rooms already share one
frame, so each room is shifted back into a frame of its own, as a real capture
would have it. What lets the rebuild put them back together:

  --with structure   roomplan/structure.json: the merged structure (built here
                     from the unshifted rooms, the way StructureBuilder places
                     them), which a real capture saves. StructureBuilder itself
                     doesn't run in the simulator.
  --with path        scan.json with the walked path only: straight from each
                     room's start to the next one's at 4 Hz, each sample in its
                     room's frame (the origin jumps back to the phone as each
                     room starts), plus a photo every 1.5 s along it
                     (frames/frames.json; small gradient images) so the rebuild
                     paints photos onto the model.

    make_legacy_scan.py <sample-dir> <Documents/Scans> --with structure|path → prints the scan id
"""

import argparse
import copy
import json
import math
import struct
import uuid
import zlib
from pathlib import Path


def origin(room: dict) -> list:
    """Where the phone might stand when the room's scan starts: inside it, at hand height."""
    floor = max(room["floors"], key=lambda s: s["dimensions"][0] * s["dimensions"][1])
    t = floor["transform"]
    xs, zs = [], []
    for x, y, z in floor["polygonCorners"]:
        xs.append(t[0] * x + t[4] * y + t[8] * z + t[12])
        zs.append(t[2] * x + t[6] * y + t[10] * z + t[14])
    return [(min(xs) + max(xs)) / 2 + 0.35, t[13] + 1.4, (min(zs) + max(zs)) / 2 - 0.25]


def shift(room: dict, o: list) -> dict:
    room = copy.deepcopy(room)
    for key in ("walls", "doors", "windows", "openings", "objects", "floors"):
        for e in room.get(key, []):
            for i in range(3):
                e["transform"][12 + i] -= o[i]
    for s in room.get("sections", []):
        for i in range(3):
            s["center"][i] -= o[i]
    return room


def structure(rooms: list) -> dict:
    merged = {"version": 2, "rooms": rooms, "interestPoints": []}
    for key in ("walls", "doors", "windows", "openings", "objects", "floors", "sections"):
        merged[key] = [e for r in rooms for e in r.get(key, [])]
    return merged


def walk(origins: list) -> list:
    samples, t = [], 0.0
    for k, a in enumerate(origins):
        b = origins[k + 1] if k + 1 < len(origins) else [a[0] + 0.5, a[1], a[2]]
        steps = max(2, round(math.dist(a, b) / 0.125))
        for i in range(steps):
            p = [a[c] + (b[c] - a[c]) * i / steps - a[c] for c in range(3)]
            samples.append({"t": round(t, 3), "p": p, "f": [0, 0, -1]})
            t += 0.25
    return samples


def png(width: int, height: int, k: int) -> bytes:
    """A small RGB gradient (PNG data; ImageIO reads it whatever the file is called)."""
    rows = b"".join(
        b"\x00" + bytes(v for x in range(width) for v in ((x * 255 // width + 37 * k) % 256, y * 255 // height, (k * 53) % 256)) for y in range(height)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def frames(samples: list, folder: Path) -> None:
    """A photo every 1.5 s, looking along the walk, posed in the same frame as its path sample."""
    (folder / "frames").mkdir()
    out = []
    for i in range(0, len(samples) - 1, 6):
        p, q = samples[i]["p"], samples[i + 1]["p"]
        f = [q[0] - p[0], 0.0, q[2] - p[2]]
        n = math.hypot(f[0], f[2])
        if n < 1e-6:
            continue
        f = [f[0] / n, 0.0, f[2] / n]
        right = [-f[2], 0.0, f[0]]  # forward × up
        name = f"frames/{len(out):06d}.jpg"
        (folder / name).write_bytes(png(320, 240, len(out)))
        out.append({
            "file": name, "t": samples[i]["t"],
            "transform": right + [0, 0, 1, 0, 0, -f[0], 0, -f[2], 0, p[0], p[1], p[2], 1],
            "intrinsics": [260, 0, 0, 0, 260, 0, 160, 120, 1], "width": 320, "height": 240, "imageWidth": 320, "imageHeight": 240,
        })
    (folder / "frames" / "frames.json").write_text(json.dumps(out))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sample", type=Path)
    parser.add_argument("scans", type=Path)
    parser.add_argument("--with", dest="mode", choices=["structure", "path"], required=True)
    args = parser.parse_args()
    paths = sorted(args.sample.glob("**/MyHome/*/capturedRoom.json"))
    assert paths, f"no capturedRoom.json under {args.sample}"
    rooms = [json.loads(p.read_text()) for p in paths]
    origins = [origin(r) for r in rooms]
    scan_id = str(uuid.uuid4()).upper()
    folder = args.scans / scan_id
    (folder / "roomplan").mkdir(parents=True)
    for k, room in enumerate(rooms):
        (folder / "roomplan" / f"room-{k + 1}.json").write_text(json.dumps(shift(room, origins[k])))
    if args.mode == "structure":
        (folder / "roomplan" / "structure.json").write_text(json.dumps(structure(rooms)))
    else:
        path = walk(origins)
        scan = {"format": "atrium.capture-scan/v1", "rooms": [], "trajectory": path}
        (folder / "scan.json").write_text(json.dumps(scan))
        frames(path, folder)
    names = [p.parent.name for p in paths]
    stats = dict(rooms=len(names), floors=1, walls=0, doors=0, windows=0, openings=0, objects=0, links=0, triangles=0, floorArea=0.0, glbBytes=0)
    record = dict(id=scan_id, createdAt="2026-10-07T12:00:00Z", roomNames=names, stats=stats, isDemo=False)
    (folder / "record.json").write_text(json.dumps(record))
    print(scan_id)


if __name__ == "__main__":
    main()
