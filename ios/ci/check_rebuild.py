#!/usr/bin/env python3
"""Checks the simulator rebuild test: after Rebuild, Apple's sample rooms (each
shifted into its own frame by make_legacy_scan.py) must fit together again.

    check_rebuild.py <scan folder> <sample-dir> --method structure|path --tolerance <meters>
"""

import argparse
import json
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("sample", type=Path)
    parser.add_argument("--method", required=True)
    parser.add_argument("--tolerance", type=float, required=True)
    parser.add_argument("--photos", action="store_true", help="the rebuild must have painted the scan's photos onto the model")
    args = parser.parse_args()
    folder, sample = args.folder, args.sample
    info = json.loads((folder / "info.json").read_text())
    print("info:", json.dumps({k: info.get(k) for k in ("pipeline", "alignment", "structure", "photos", "photoCoverage")}))
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
    methods = {r["method"] for r in report["rooms"]}
    assert methods == {args.method}, f"rooms placed by {methods}, expected {args.method}"
    bad = {r: round(e, 3) for r, e in worst.items() if e > args.tolerance}
    assert not bad, f"rooms not back in place: {bad}"
    print(f"rooms fit together again ({args.method}, within {args.tolerance} m)")

    if args.photos:
        manifest = json.loads((folder / "manifest.json").read_text())
        assert manifest.get("appearance") == "captured", f"manifest appearance: {manifest.get('appearance')}"
        assert info.get("photoCoverage", 0) >= 0.15, f"photos cover {info.get('photoCoverage')}"
        glb = (folder / "scan.glb").read_bytes()
        length = int.from_bytes(glb[12:16], "little")
        gltf = json.loads(glb[20:20 + length])
        mimes = [i.get("mimeType") for i in gltf.get("images", [])]
        assert mimes and all(m == "image/jpeg" for m in mimes), f"atlas images: {mimes}"
        assert all("KHR_materials_unlit" in m.get("extensions", {}) for m in gltf["materials"]), "materials must be unlit"
        print(f"photos painted on: {info['photos']} photos cover {info['photoCoverage']:.0%}, {len(mimes)} JPEG atlas(es)")
        # The "photos off" view: the clean styled model of the same rooms, lit.
        clean_path = folder / "scan-clean.glb"
        assert clean_path.exists(), "no clean model (scan-clean.glb) next to the photo model"
        clean = clean_path.read_bytes()
        clean_gltf = json.loads(clean[20:20 + int.from_bytes(clean[12:16], "little")])
        assert "KHR_lights_punctual" in clean_gltf.get("extensions", {}), "the clean model should carry its lights"
        assert not any("KHR_materials_unlit" in m.get("extensions", {}) for m in clean_gltf["materials"]), "the clean model is lit"
        clean_rooms = clean_gltf["scenes"][0]["extras"]["atrium"]["rooms"]
        assert len(clean_rooms) == len(manifest["rooms"]), "the clean model covers the same rooms"
        print(f"clean model: {len(clean) / 1e6:.1f} MB, {len(clean_rooms)} rooms")


if __name__ == "__main__":
    main()
