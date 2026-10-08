"""Fills the page's notes and the splat run's facts into site/views.json.

  python3 tools/finalize.py <train.log> <splat count> <hours>
"""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
log, count, hours = Path(sys.argv[1]).read_text(), int(sys.argv[2]), float(sys.argv[3])
interim = "--interim" in sys.argv
steps = max(int(m) for m in re.findall(r"test PSNR @(\d+)", log))
doc = json.loads((root / "site/views.json").read_text())
s = doc["summary"]
s["splat"]["time"] = "10–20 minutes on a cloud GPU"
s["today"]["time"] = s["lidar"]["time"] = "About 10 seconds"
best_wins = [v["short"] for v in doc["views"] if v["psnr"]["splat"] > max(v["psnr"]["today"], v["psnr"]["lidar"]) + 0.3]
lidar_wins = [v["short"] for v in doc["views"] if v["psnr"]["lidar"] > v["psnr"]["splat"] + 0.3]
doc["notes"] = [
    "The apartment is synthetic: Atrium's demo scan rendered as a real home, with real furniture shapes, clutter RoomPlan doesn't report, two mirrors, a glossy kitchen floor and views out of the windows. That is what lets every result be scored against the exact photo it should reproduce. Real homes add auto-exposure, motion blur and people.",
    f"All three were built from the same 665 photos at 480 × 360, a quarter of the width of the iPhone's 1920 × 1440 photos, so everything here is softer than a real scan. The painted models come from the code the phone runs (build 6 and build 7). The page draws the splats the way they were trained (Gaussians out to 3σ, colors blended in sRGB); three.js's stock splat settings would cost them about 1.4 dB here.",
    f"The photoreal model was trained on this server's 4-core CPU, with no GPU: {count:,} splats, {steps:,} steps, about {hours:.1f} hours. On a cloud GPU, with the phone's full-resolution photos and a few million splats, the same method takes 10–20 minutes and looks clearly sharper, so read its quality here as a floor.",
    "Splats win where a painted surface can't follow the scene: views out of windows, reflections, plants, lamp shades and thin chair legs, and anything the scan's boxes or mesh got wrong" + (f" (here: {', '.join(best_wins[:5])})." if best_wins else "."),
    "Splats lose where few photos looked: soft blur and floating specks appear behind furniture and in corners" + (f"; build 7 is closer to the real photo at {', '.join(lidar_wins[:4])}." if lidar_wins else ".") + " They are also a heavier download, can't be edited like a texture (painting out a person, fixing a wall), and give no clean photos-off model; the painted model would stay for that, for the floor plan and for older phones.",
    "Suggested path: ship build 7 now (free, on the phone). Add photoreal as an upgrade made in the cloud after upload: send the photos and poses with the scan, train on a GPU worker, store the splats next to the painted model, and give the viewer a Photoreal switch like Photos on/off. At $0.10–0.50 of GPU time per listing it fits inside the $19 price.",
]
if interim:
    doc["notes"].insert(0, f"Early snapshot: the photoreal model is still training (this is step {steps:,} of 12,000). The page will be updated with the finished model.")
(root / "site/views.json").write_text(json.dumps(doc, indent=1))
print("notes written;", len(best_wins), "views where splats win clearly,", len(lidar_wins), "where build 7 does")
