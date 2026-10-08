"""Side-by-side sheet: python3 tools/sheet.py out.png <view indices> <dir1> <dir2> ... (dirs hold 00.png, 01.png, …)"""
import sys
from PIL import Image, ImageDraw
out, views, dirs = sys.argv[1], [int(v) for v in sys.argv[2].split(",")], sys.argv[3:]
W, H = 480, 360
sheet = Image.new("RGB", (W * len(dirs), H * len(views) + 24), "white")
d = ImageDraw.Draw(sheet)
for c, folder in enumerate(dirs):
    d.text((c * W + 8, 6), folder, fill="black")
    for r, v in enumerate(views):
        sheet.paste(Image.open(f"{folder}/{v:02d}.png").convert("RGB"), (c * W, 24 + r * H))
sheet.save(out)
