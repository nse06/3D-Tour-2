#!/usr/bin/env python3
"""Turns Apple's RoomPlan multi-room sample into a scan as Atrium Capture builds
1–2 saved it, for the simulator rebuild test in .github/workflows/ios.yml.

RoomPlan reports every room of a multi-room scan relative to where the phone
was when that room's scan started. Apple's sample rooms already share one
frame, so each room is shifted back into a frame of its own (as a real capture
would have it). RoomPlan's merge works from data inside each file that the
shift doesn't touch, so the rebuild has to put the rooms back together.

    make_legacy_scan.py <sample-dir> <Documents/Scans> → prints the scan id
"""

import json
import sys
import uuid
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
    for key in ("walls", "doors", "windows", "openings", "objects", "floors"):
        for e in room.get(key, []):
            for i in range(3):
                e["transform"][12 + i] -= o[i]
    for s in room.get("sections", []):
        for i in range(3):
            s["center"][i] -= o[i]
    return room


def main():
    sample, scans = Path(sys.argv[1]), Path(sys.argv[2])
    rooms = sorted(sample.glob("**/MyHome/*/capturedRoom.json"))
    assert rooms, f"no capturedRoom.json under {sample}"
    scan_id = str(uuid.uuid4()).upper()
    folder = scans / scan_id
    (folder / "roomplan").mkdir(parents=True)
    names = []
    for k, path in enumerate(rooms):
        room = json.loads(path.read_text())
        (folder / "roomplan" / f"room-{k + 1}.json").write_text(json.dumps(shift(room, origin(room))))
        names.append(path.parent.name)
    stats = dict(rooms=len(names), floors=1, walls=0, doors=0, windows=0, openings=0, objects=0, links=0, triangles=0, floorArea=0.0, glbBytes=0)
    record = dict(id=scan_id, createdAt="2026-10-07T12:00:00Z", roomNames=names, stats=stats, isDemo=False)
    (folder / "record.json").write_text(json.dumps(record))
    print(scan_id)


if __name__ == "__main__":
    main()
