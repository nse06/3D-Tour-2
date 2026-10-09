#!/usr/bin/env bash
# Builds everything tools/eval_modal.py needs, from nothing, into <out> (default: eval-data/):
#
#   data/            the synthetic capture: photos, held-out views, the real triangles (scene/render.mjs, tools/prep.py)
#   data-rough/      the same capture as rough as a real scan (tools/roughen.py)
#   capture-clean/   what the phone would upload for each (scanproc paint --photoreal, tools/rgb_frames.py):
#   capture-rough/   cameras.json, seeds.ply, frames/
#   views/           the real apartment from the evaluation viewpoints (tools/eval_views.py, scene/render_views.mjs)
#
#   tools/eval_data.sh [out]
#
# Needs Node 20+, Python 3 with numpy, Pillow, scipy and scikit-image, Chromium (CHROMIUM=<path> unless
# Playwright's own is installed) and ScanCore's scanproc (SCANPROC=<path>, or Swift on the PATH to build
# it). Steps already done are skipped, so a failed run can be resumed. About 20 minutes on 4 cores.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "${1:-$HERE/eval-data}"
OUT=$(cd "${1:-$HERE/eval-data}" && pwd)
PY=${PY:-python3}
PORT=${PORT:-8931}
SCANPROC=${SCANPROC:-$ROOT/ios/ScanCore/.build/release/scanproc}

if [ ! -x "$SCANPROC" ]; then
  echo "building scanproc"
  (cd "$ROOT/ios/ScanCore" && swift build -c release --product scanproc)
fi
# The scene loads three.js from the app's own node_modules (server.mjs serves it as /three).
[ -d "$ROOT/node_modules/three" ] || (cd "$ROOT" && npm ci --no-audit --no-fund)
cd "$HERE"
[ -d node_modules/playwright-core ] || npm install --no-audit --no-fund --no-package-lock

node server.mjs "$PORT" > "$OUT/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
curl -sf --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:$PORT/scene/index.html"

if [ ! -f "$OUT/data/test.json" ]; then
  echo "rendering the synthetic capture"
  node scene/render.mjs "$PORT" "$OUT/data"
fi
[ -f "$OUT/data/points.npz" ] || $PY tools/prep.py "$OUT/data" "$SCANPROC"
[ -d "$OUT/data-rough/meshes" ] || $PY tools/roughen.py "$OUT/data" "$OUT/data-rough"

for kind in clean rough; do
  src="$OUT/data"
  [ "$kind" = rough ] && src="$OUT/data-rough"
  if [ ! -f "$OUT/capture-$kind/seeds.ply" ]; then
    echo "painting the $kind capture"
    "$SCANPROC" paint "$src/scan.json" "$OUT/painted-$kind.glb" --images "$src/rgb" --meshes "$src/meshes" --keep-frame --photoreal "$OUT/capture-$kind" > "$OUT/paint-$kind.log"
  fi
  $PY tools/rgb_frames.py "$src/rgb" "$OUT/capture-$kind"
done

if [ ! -f "$OUT/views/views.json" ]; then
  $PY tools/eval_views.py "$OUT/data" "$OUT/capture-rough" "$OUT/views.json"
  node scene/render_views.mjs "$PORT" "$OUT/views.json" "$OUT/views"
fi
du -sh "$OUT"/capture-* "$OUT/views"
