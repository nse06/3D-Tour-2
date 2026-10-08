#!/bin/bash
# After training: export, assemble the page, capture every viewpoint, score, write the notes.
#   tools/final.sh [run dir]    (PRIOR_SECS: training time of an earlier run this one resumed from)
set -e
cd "$(dirname "$0")/.."
PY=${PY:-python3}
RUN=${1:-runs/main}
$PY -W ignore splat/export.py $RUN/ckpt.pt out/splats-final.spz | tee out/export.log
$PY -W ignore splat/render_views.py $RUN/ckpt.pt data eval/splat-py-final
python3 tools/build_site.py out/splats-final.spz
node tools/capture.mjs 8931 eval/page-final
$PY -W ignore tools/evaluate.py eval/page-final | tee out/evaluate.log
COUNT=$(grep -oE "^[0-9]+ splats" out/export.log | grep -oE "^[0-9]+")
SECS=$(grep -oE "it [0-9]+ .* ([0-9]+)s \(" $RUN/train.log | tail -1 | grep -oE "[0-9]+s \(" | grep -oE "[0-9]+")
HOURS=$(python3 -c "print(round(($SECS + ${PRIOR_SECS:-0}) / 3600, 1))")
python3 tools/finalize.py $RUN/train.log $COUNT $HOURS
echo "final: $COUNT splats, $HOURS h"
