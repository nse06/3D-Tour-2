# Painted model vs photoreal, round 3

The rough synthetic capture (`data-rough`, as messy as a real scan), from the evaluation viewpoints of
`tools/eval_views.py`, against the real apartment. Painted: the build 9 painted model (`scanproc paint`) rendered with
`scene/render_model_views.mjs` (scores in `painted-b9-scores.json`). Photoreal: the `priors` variant in
`results.json` (room-shape rules, visible-only Adam, anchored exposure).

PSNR / SSIM / LPIPS per kind of view (higher PSNR and SSIM, lower LPIPS are better):

| | wall 1.2 m (19) | wall 0.6 m (19) | wall at 45° (19) | between (22) | spots (9) |
|---|---|---|---|---|---|
| Painted (build 9) | 25.75 / 0.844 / 0.238 | 27.61 / 0.871 / 0.249 | 24.79 / 0.875 / 0.199 | 25.80 / 0.844 / 0.177 | 21.08 / 0.767 / 0.215 |
| Photoreal (priors) | 26.75 / 0.870 / 0.269 | 27.90 / 0.889 / 0.255 | 26.37 / 0.897 / 0.233 | 26.76 / 0.880 / 0.176 | 22.61 / 0.815 / 0.161 |

16 of the 104 views (`mirror-views.json`) look into a mirror whose ground truth changes from one render to the next
(the reference renderer's reflection depends on draw order), so neither side is scored on them.

Photoreal is ahead on PSNR and SSIM everywhere. On LPIPS the painted model's crisp textures still win close to walls,
and the splats win between rooms and at the photo spots. That is the viewer's split (docs/photoreal.md §4):
photoreal around the photo spots, the painted model up close.
