#!/bin/bash
# Paints a capture with ScanCore and scores the model at the held-out views, for tuning the painting.
#   SCANPROC=… tools/bench_paint.sh <capture-dir> <name> [--meshes]
# Needs `node server.mjs 8931` running here. The model and its renders land in out/ and eval/.
set -e
cd "$(dirname "$0")/.."
CAPTURE=$1
NAME=$2
MESHES=""
[ "$3" = "--meshes" ] && MESHES="--meshes $CAPTURE/meshes"
START=$(date +%s)
"$SCANPROC" paint "$CAPTURE/scan.json" "out/bench-$NAME.glb" --images "$CAPTURE/rgb" $MESHES --keep-frame --poses "out/bench-$NAME.poses.json" > "out/bench-$NAME.log"
echo "painted in $(( $(date +%s) - START )) s: $(grep -E 'triangles|photos|LiDAR' "out/bench-$NAME.log" | tr '\n' ' ' | cut -c1-260)"
node scene/render_model.mjs 8931 "/out/bench-$NAME.glb" data "eval/bench-$NAME" > /dev/null
${PY:-python3} tools/score.py data "eval/bench-$NAME"
