#!/usr/bin/env python3
"""Checks the simulator rebuild test: after Rebuild, Apple's sample rooms (each
shifted into its own frame by make_legacy_scan.py) must fit together again.

    check_rebuild.py <scan folder> <sample-dir>
"""

import json
import math
import sys
from pathlib import Path


def main():
    folder, sample = Path(sys.argv[1]), Path(sys.argv[2])
    report = json.loads((folder / "alignment.json").read_text())
    print("alignment:", json.dumps({k: v for k, v in report.items() if k != "rooms"}))
    for r in report["rooms"]:
        print(f"  {r['name']:12s} {r['method']:10s} matched {r['matchedElements']:3d} residual {r.get('residual')}")
    scan = json.loads((folder / "scan.json").read_text())

    truth = {}
    for path in sorted(sample.glob("**/MyHome/*/capturedRoom.json")):
        for w in json.loads(path.read_text())["walls"]:
            truth[w["identifier"]] = (path.parent.name, w["transform"])
    pairs = [(truth[w["id"]][0], truth[w["id"]][1], w["transform"]) for w in scan["walls"] if w["id"] in truth]
    assert len(pairs) > 20, f"only {len(pairs)} walls matched the sample"

    # One turn + shift for the whole home (the merged structure's frame is RoomPlan's choice).
    angles = []
    for _, a, b in pairs:
        angles.append(math.atan2(a[2], a[0]) - math.atan2(b[2], b[0]))
    yaw = math.atan2(sum(math.sin(x) for x in angles), sum(math.cos(x) for x in angles))
    c, s = math.cos(yaw), math.sin(yaw)

    def turn(t):  # aligned (b) → truth frame, before the shift
        return (c * t[12] + s * t[14], -s * t[12] + c * t[14])

    dx = sum(a[12] - turn(b)[0] for _, a, b in pairs) / len(pairs)
    dz = sum(a[14] - turn(b)[1] for _, a, b in pairs) / len(pairs)
    worst = {}
    for room, a, b in pairs:
        x, z = turn(b)
        worst[room] = max(worst.get(room, 0), math.hypot(a[12] - x - dx, a[14] - z - dz))
    for room, err in sorted(worst.items()):
        print(f"  {room:12s} off by {err:.3f} m")
    bad = {r: e for r, e in worst.items() if e > 0.05}
    assert not bad, f"rooms not back in place: {bad}"
    print("rooms fit together again")


if __name__ == "__main__":
    main()
