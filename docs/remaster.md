# Remastered models

A photo scan's walkthrough is the **painted model**: RoomPlan's walls, floors and furniture (and the LiDAR's
shapes), with the photos painted on by the phone (docs/iphone-capture.md §2.4). The **remastered model** is the same
model rebuilt on a cloud GPU from the photos kept on the server: skins learned from every photo at once, spots no
photo saw filled in by an AI, and, step by step, AI-cleaned photos, AI-made furniture, trim and photo spots. It's a
look of its own, next to photos on/off and photoreal, and the realtor chooses which one buyers see.

It's a **separate process from the photoreal splats** (docs/photoreal.md): its own worker (`worker/remaster`, package
`atrium_remaster`), its own Modal app (`atrium-remaster`), its own jobs (`remaster_jobs`), its own file on the tour
(`tours.remaster_url`) and its own look (`appearance = "remastered"`). It only borrows the photos a photoreal upload
left on the server (docs/photoreal.md §2.1), so either can be switched off, redeployed or dropped without the other.

| Idea | Stage | Status |
|---|---|---|
| Train the skins on every photo | `skins.py` (§2) | built; GPU eval on the synthetic apartment (round 3): better than the painting in PSNR on every kind of view but plain walls up close (25.8 vs 26.3 dB, where SSIM and LPIPS are better) |
| Fill spots no photo saw | `fill.py` (§3), LaMa | built; plain surfaces get a smooth fill (LaMa drew stripes on a real ceiling), textured ones LaMa |
| Clean up the photos (sharpen, TV off, windows) | `cleanup.py` (§4.1), NAFNet | built |
| The Fixer's cleaned views feed the skins | `fixviews.py` (§4.2) | built; off unless asked (`fixerViews`): nothing gained on the synthetic apartment, for a GPU more |
| Sharper depth from AI | `depth.py`, `fuse.py` (§4.3), Prompt Depth Anything | built: photo pixels where the shape is wrong say nothing; the LiDAR's pieces fused anew from it |
| AI-made furniture | `furniture.py` (§4.4), SAM 2.1, TripoSG | built: fitting tested on CPU; TripoSG's GPU run next |
| Trim: doors and windows set into their walls, baseboards, crown moldings, casings, cabinet doors | `trim.py` (§4.5) | built; the doors, windows, casings and cabinets wait for a build-13 scan; white baseboards on off-white walls are mostly too faint in the phone's painting to be found |
| The room layout from the phone (walls, doors, windows, furniture boxes) | build 13, `cameras.json` `layout` (docs/photoreal.md §1) | done |
| Photo spots | `spots.py`, viewer's `PhotoSpots` (§4.6) | built: tested on CPU and in Chromium on a synthetic room |
| Better lighting: neutral white balance, daylight exposure, soft highlights | `light.py` (§4.8) | built: on by default (`"light": false` turns it off) |

## 1. Flow

1. The phone sends the scan, then **Make it photoreal** uploads its photos (`cameras.json`, `seeds.ply`, `frames/`,
   `masks/`) for photoreal; they stay on the server afterwards.
2. On the listing page, **Remaster with AI** (`startRemasterAction`) creates a `remaster_jobs` row for the listing's
   current tour, pointing at the upload whose photos it uses (`inputs_job_id`), and hands it to the remaster GPU
   (`REMASTER_GPU_URL`) with signed links to the photos and the painted model's URL (`lib/remaster.ts`). Photos a
   queued or running remaster uses aren't deleted, even when a newer upload replaces them, and **Delete the photos**
   waits for it.
3. The worker reports to `/api/remaster/jobs/<id>` (§5) and uploads `model.glb` (storage kind `remaster`). Done, the
   model goes on the tour (`tours.remaster_url`) unless the listing was sent a new scan since, or a newer remaster of
   the same scan finished first.
4. Buyers see nothing new until the realtor chooses: on the listing page (**Painted | Remastered**), or in **Rooms &
   viewpoints**' look picker. In the preview, a **Painted | Remastered** switch compares the two from the same spot
   (the viewer loads the other model the first time it's asked for and keeps the camera).

Remastering is covered by the listing's photoreal (the same entitlement; free during the beta, docs/billing.md).

## 2. Skins trained on every photo (`skins.py`)

The phone paints each spot from the one photo that sees it best: a surface becomes a few patches, each from a single
photo, with exposure matched and seams leveled. The remaster keeps the model's shapes and learns its atlases from all
the photos at once, by gradient descent, like the splats, except that nothing can move off the surfaces:

* **Where each pixel lands**: every photo is ray cast against the model (Open3D's `RaycastingScene`, MIT; Embree
  underneath, on the CPU): per pixel the triangle, the spot on it (barycentric weights) and the depth, so the texel it
  sees (`views.py`).
* **What a pixel may say**: nothing within 3 px (at 1920 px) of a jump in depth or a seam between surfaces at more
  than 30° (where a small error in the shapes would put one surface's color on another), nothing more than 78° off
  head-on, nothing where the photo shows people (the phone's masks). A blown-out channel (0.98 or brighter: a
  window's glass, a lamp) says only that the surface is at least that bright, so it pulls a texel up but never down.
  Counted like any other pixel, a blown-out pixel in a photo brighter than the rest pulled the glass down toward
  grey (on the test room's sunlit patch: 0.82, where it now comes out white).
* **Per photo**: a gain and an offset per channel (auto exposure and white balance), started from the ratio of the
  photo's colors to the painting's and kept near it, their average held at the painting's (so what the photos saw
  keeps the brightness of what they didn't); and a small shift, turn and zoom (what lining the photos up on the phone
  left). A full color matrix per photo let the skins trade colors with the photos where few photos look.
* **Smeared photos** are compared with the render smeared the same way (atrium_photoreal's motion smear, its
  direction found once the skins take shape).
* **Finer texels**: the atlases are learned at twice the phone's texel density (8 mm → 4 mm), within 40 M texels for
  the whole home (a multiple of 16 on a side, so mipmaps line up). Each pixel reads the mipmap its footprint covers
  (a floor seen at a grazing angle doesn't alias).
* **Seldom seen texels**: with hundreds of photos, a texel is in a step's photos now and then. The optimizer is a
  lazy Adam: only what a step's photos reach moves, each by its own history. torch's Adam kept every texel moving on
  its momentum and divided a seldom seen texel's next gradient by a variance that had decayed meanwhile; with a
  pyramid of coarser layers on top (a layer's texel a block of the finest), that turned the synthetic apartment's
  665-photo skins into colored blotches (round 1: 18 dB where the painting has 24). The pyramid is gone too
  (`levels` 1).
* **The last steps**: the learning rate eases down (a cosine) to a tenth of itself by the last step (`anneal`), so
  the skins settle on what all the photos say rather than on the last few steps' photos. On the synthetic room that
  took a sixth off the grain on plain walls; on the synthetic apartment it gained 0.3–0.6 dB on walls and between
  the photo spots, 0.1 dB on the textured spots (round 3). Leaning texels few photos saw back to the painting (`confidence`) took more grain off but added error on
  new viewpoints, so it's off.
* **What no photo saw** keeps the phone's colors exactly; the coverage map goes on to the fill (§3).

On a synthetic room with exact ground truth (`worker/remaster/tests/room.py`: a painted atlas softened, with a
different brightness per chart and a flat patch; 16 photos with different exposures, noise and two smeared), trained
skins cut the error on new viewpoints from 0.129 to 0.074 (the truth at the phone's texel size: 0.055); with 96 photos,
each step one small tile (seldom seen texels), from 0.130 to 0.084, their color left as the photos have it (the old
optimizer: 0.124, with blotches).

On a GPU (an A10G), on the synthetic apartment (665 photos, the eval views of docs/photoreal.md;
`prototypes/photoreal/results/remaster-round-3`), the job's defaults take about 6 minutes and make a 8.7 MB model
that beats the painting on walls at 1.2 m (24.7 dB vs 24.5), at 45° (24.9 vs 23.9), between the photo spots (24.1 vs
23.9) and on the sofa, rug and kitchen (21.2 vs 20.1), in PSNR and SSIM, and in LPIPS too but for a hair at 45°
(0.213 vs 0.210). On plain walls at 0.6 m the painting keeps 0.5 dB (26.3 vs 25.8; SSIM and LPIPS are better in the
skins): what's left there is a faint uneven tone, broad bands where one photo's share of a wall gives way to
another's, at 33–43 dB where the painting has 43–46. AI depth (§4.3) with the fill and the sharpening improves SSIM and
LPIPS on every kind of view and leaves PSNR within 0.15 dB, for 2.5 minutes more; trim changes nothing there (it has
no layout) and the Fixer's views (§4.2) nothing. Views through a window show the outside ghosted (each photo sees it
from elsewhere), where the painting shows one photo's view.

## 3. Spots no photo saw (`fill.py`)

A flat surface's chart is a straight-on picture of it (walls, floors, ceilings, a cabinet's faces). Where the photos
covered at least 30% of such a chart but left holes of 64 texels or more, each hole (grown by a texel) is filled by
what's around it (the seen texels within 24 of it):

* **Plain** (less fine detail than 0.008: the mean distance of a texel from its 9×9 neighborhood's mean, in sRGB; a
  ceiling, a painted wall): smoothly, from the chart's own seen texels (pull-push, its coarse levels blended back up
  linearly). An image model has nothing to continue there: on the first real room, LaMa drew blue stripes across a
  kitchen ceiling the photos barely saw.
* **Textured** (planks, tiles, a patterned wall): by an inpainting model, which continues the texture into the hole:
  **LaMa** (big-lama; IOPaint's TorchScript export) on the GPU, the smooth fill in tests. It gets the chart and 16
  texels past its edges, those carried on smoothly from the chart's own colors (past its edges the atlas holds other
  surfaces). A fill with more than twice the fine detail of what's around its hole is turned down for the smooth one.
  Charts over 2048 px are filled at that size and the filled part scaled back up.

Curved charts (LiDAR furniture patches) keep the phone's smooth fill: an image model would draw across their folds.

## 4. More stages

### 4.0 Loose pieces (`loose.py`)
The LiDAR mesh keeps whatever stood in front of it while it scanned: someone walking through leaves pieces of legs
hanging in the room, and a shoe keeps only its top, floating over the floor. The phone drops them since builds 19
and 20, but scans sent before still carry them. First thing, by the phone's rules: a piece that touches nothing
(more than 12 cm off the floor, 15 cm from every wall, 60 cm under the ceiling, in no RoomPlan box, no wider than
80 cm, no bigger than 0.25 m²) goes, and so does low clutter (starting within 17 cm of the floor, rising 3–30 cm, no
wider than 1 m, in no box; flat at the floor it's floor, a doorway's patch). Then, once the depth model has
measured the photos (§4.3): a piece up to 0.5 m², in no box, that the photos see straight through (inside its
outline, in at least 3 photos and 60 pixels, 75% of them find the room farther away) goes too, near a wall or not.
The stats carry `looseFloating`, `looseLow`, `looseArea`, `looseSeenThrough` and `looseSeenThroughArea`
(`"loose": false` turns it off). On the published two-room scan the rules take 31 floating pieces and 14 low ones
(1.04 m²), the floating leg pieces in the living room among them, and keep the doorway's floor patches.

### 4.1 Photo cleanup (`cleanup.py`, `nafnet.py`)
Before the skins learn from them, photos the phone smeared by 1.5 px or more (at 1920 px, atrium_photoreal's estimate
from how fast the phone turned) are sharpened by **NAFNet** (MIT; its REDS deblur weights, on the GPU in tiles), and
the skins count what's left of the smear as 30% of it. With the room layout, a TV's screen (the faces inside
RoomPlan's TV box, facing along its thinnest side) says nothing in training, since it shows a different picture in
every photo, and is painted as a TV that's off; windows whose glass came out dark get a soft daylight gradient,
keeping their frames. Nothing else about the home changes.

### 4.2 The Fixer's views (`fixviews.py`)
Twice during training (at 45% and 85% of the steps), 80 views from where buyers walk (each round further from the
photos) are rendered from the skins so far, cleaned up by NVIDIA's Fixer (on a GPU of its own), tone-locked to the
render (its broad shading put back: the Fixer may tidy detail, not relight) and added to training at half a photo's
weight, a quarter of each batch. They don't count as seen for the fill. It runs only when the job's `fixerViews` is
true: on the synthetic apartment it changed nothing measurable in two GPU rounds (within 0.1 dB either way), for
2 minutes and a second GPU more.

### 4.3 Sharper depth (`depth.py`)
**Prompt Depth Anything** (ViT-L) turns the model's own depth at each photo (rendered at the LiDAR's 256×192) into
sharp depth at 960 px. Where the two disagree by more than 4 cm + 4% (grown by 2 px), the photo's pixels say nothing:
the model's shape is off there (a furniture edge, clutter the scan smoothed over) and its colors would land on the
wrong surface.

The same depth reshapes what the LiDAR scanned (`fuse.py`): for each piece the phone kept as the LiDAR's mesh
(shelves, a kitchen island, a toilet; a sofa the furniture stage left alone), the depth of up to 24 photos that see
it is fused into one surface within its box (Open3D's TSDF, 1 cm voxels), less what lies on the rest of the model
(the floor under it, the wall behind it). It replaces the scanned shape only if it explains at least 5% more of the
piece's pixels' depth (within 3 cm + 2%) than the scanned shape did. The depth is measured once, after the trim and
the furniture, and compared with the final shapes for the skins.

### 4.4 AI-made furniture (`furniture.py`, `triposg.py`)
For each movable piece in the room layout (sofas, chairs, beds and tables; never built-ins), the photos that see
its box at least half in frame and at least 12% of the photo across are ranked by how much of the scanned piece
they show (the steadier photo first). The best one that shows it whole and up to four more, looking at it from
directions at least 20° apart, are read at 960 px, and **SAM 2.1** (Hiera-L, Apache-2.0, through transformers)
cuts the piece out of each with its box as the prompt, kept within the box's outline, its holes filled (a throw on
a sofa's seat is the sofa's). Of the clearest few whole views, the one where the least of the piece is hidden
(by a coffee table, say: the model knows what stands in front of it) gives the cutout for **TripoSG** (VAST-AI,
MIT; its own GPU and image), on white with 10% around it; what's hidden in it is painted in by LaMa first, since
TripoSG would otherwise build the gap into the shape. TripoSG makes the piece's shape (about 30 s on an A10G; it
comes out upright, y up, and is cut to 30,000 triangles). That shape is turned about its up axis (four quarter turns, mirrored or not), stretched to fill the box
RoomPlan measured, and the turn whose outline best matches the cutouts wins (overlap counted only where nothing
in front hides the piece). At 60% overlap or better, and at least 5 points better than the scanned piece's own
outline (`furnitureFit` and `furnitureScannedFit` in the stats), it replaces the scanned piece (the box's faces or
the LiDAR's shape, never the floor, a wall or a baseboard behind it), with new texels that start as the piece's
color and that the skins (§2) learn from the photos like the rest; otherwise the scanned piece stays. (A real
armchair the LiDAR had caught whole was swapped for a made one that came out a lumpy blob.)

When the AI reviewer (§4.9) has looked the scan over, only the pieces it picks are made (none picked, the stage
doesn't run): on a real two-room home all ten pieces kept their scans for 12.6 minutes of GPU. A pick replaces the
scan without having to beat its outline, since a hole hardly changes an outline and the reviewer saw the scan is
broken: a made shape at 60% overlap; RoomPlan's box (for what's a box in real life) at 30%, just enough to show
it's where the photos see the piece, and no more than 10 points worse than the scan, since RoomPlan's box isn't
always the piece (a real sofa's, taking in its back cushions, came out a block at 0.55 to the scan's 0.76; a side
table's box, which looked right, scored 0.55 to about 0.59). `furnitureAll: true` makes every movable piece as before.

TripoSG runs with its marching-cubes decoder (scikit-image). Its fast decoder's mesher (diso) and its background
remover (RMBG-1.4) aren't used, since neither license is one we take on: the image puts a stub in place of diso
for TripoSG's imports, and the cutouts come from SAM. To try it on one photo:
`modal run modal_app.py::make_shape --image photo.jpg --box x0,y0,x1,y1 --out folder` (the cutout and an OBJ).

### 4.5 Trim (`trim.py`, `edit.py`)
With the room layout, every window and closed door is set 10 cm into its wall (`recessDepth`): the wall is cut
around it (keeping its painted texels), the door or window sits back showing the texels painted for it (a door cut
down to the floor) and its reveals are new surfaces. Then the skins as the phone painted them are read for trim, each
piece a slab standing out of its wall with the texels painted there on its face:

* **Baseboards**: a band 6–25 cm tall along the bottom of a wall, of one even color (all along the wall, and from
  its bottom to its top) that differs from the wall above it, in at least half the wall's columns (furniture hides
  the rest). 12 mm out of the wall; it stops at doors.
* **Crown moldings**: the same along the top, 6–20 cm, 2 cm out.
* **Casings**: a band 4–12 cm wide on both sides of a door or window and over it, of one width and color (and under
  a window, if it has an apron), 15 mm out.
* **Cabinet doors**: on the fronts of RoomPlan's storage boxes (the face away from the wall a box stands against),
  thin dark lines from top to bottom are the gaps between doors, and across a column the gaps between drawers: each
  becomes a groove 6 mm wide and 15 mm deep. A dark band along the bottom, the toe kick (6–16 cm), is set 6 cm back.

What the skins don't clearly show stays flat (a checked wall isn't a baseboard, a blurred line isn't a band). The new
surfaces (reveals, the slabs' sides, the grooves' sides) share one new atlas (xatlas, at the model's texel size) and
are learned from the photos like the rest. Scans from before build 13 have no layout: only baseboards and crown
moldings are looked for.

On the synthetic apartment (white baseboards 9 cm tall on off-white walls in five of its six rooms), trim finds one
baseboard, a true one: in the phone's painting the others differ from their walls by 0.01–0.06 (the bar is 0.07) and
shift by a few centimeters from photo to photo. Reading them from the trained skins (sharper, lined up) after
training, with a lower bar held up by how evenly the band runs along the wall, is the next step for it. Trim takes
seconds there.

### 4.6 Photo spots (`spots.py`, the viewer's `PhotoSpots.tsx`)
Where the photos were taken, buyers see the photos, as in Matterport and Zillow tours. The photos taken within 1 m
of each other (across the floor, in the order they were taken) make a spot, at the middle of where they were taken,
if it's at least 25 cm from every surface. From each spot the worker renders a cube of six 1024 px views of the
finished model and paints the photos over it: each pixel from the photos (the spot's own and up to 24 taken within
3.5 m) that saw the same point from nearly the same direction, by the angle between their line of sight and the
spot's (8° fades a photo's say by two thirds), never across something in front (the model's depth at the photo)
nor where it showed people or the depth model disagreed (both masks coarse: what they leave out fades back in over
a few pixels around it, instead of the phone's people grid stepping from cell to cell, which showed as jagged
outlines on floors) or was blown out (a window's glass: white in the photo however bright it really is, so a
photo the skins found brighter than the rest would show it grey once its brightness is undone; the model, whose
skins know it's white, shows there), fading in from each photo's border, and with each photo's
color and alignment as the skins learned them, so the photos agree with each other and with the model. Where no
photo saw the point, the model shows. The photos get the lighting (§4.8) as they're painted in; the model has it
already. (Lighting the finished cubes, as the first spots did, lit the model's parts twice: a real home's spot
ceilings came out a quarter too bright and pink.) Each cube is one JPEG, its faces in OpenGL's layout in a 3 × 2 grid (+x −x
+y over −y +z −z), which WebGL samples as stored (checked in Chromium).

The pictures upload before the model (storage kind `spot`), and the model lists them in its scene's extras
(`atriumSpots`: version, face size, and per spot its position, picture and photo count), so nothing else on the site
changes. The viewer, while the remastered model shows, loads the spot nearest the camera (three at most in
memory), renders its distances once (a 512 px cube camera, read at five texels for a soft edge), and projects its
photos onto the model from the spot where the spot saw that surface (`photo-spot-shader.ts`). The photos sit on the
model's shapes, so whatever a shape has wrong (a painting leaning 30 cm out from its wall, clutter the scan caught
in pieces) shows displaced when seen from elsewhere, by more the farther the viewer's line of sight turns from the
spot's: per pixel, a photo shows fully where the two lines of sight are within 6° and gives way to the skins by
20°. One spot shows at a time, so nothing shows twice: the nearest, fully within 60 cm and fading out by 1.6 m,
until another is 15 cm nearer; then the two crossfade over 0.45 s. (Blending the two nearest, as the first viewer
did, showed a misplaced painting twice, see-through; a real two-room home showed it.) Nothing marks the spots on the
floor: the walkthrough is free to walk, and the photos fade in near them.

### 4.7 (reserved)

### 4.8 Better lighting (`light.py`)

Homes are scanned under whatever light they had. After the fill, one color adjustment for the whole home is
measured from its walls (textured triangles facing sideways, sampled by area): the brighter half of the wall
texels that share the walls' typical tint (feature walls and art differ from it and are left out) sets the white
balance (85% of their tint taken out, no channel moved more than 40%), and the walls' median brightness sets the
exposure, toward sRGB 0.8 (brightening at most 1.8×, darkening at most 0.9×). Then shadows open up a little
(luminance to the power 0.88) and highlights roll off above linear 0.8 instead of clipping, as steep where they
start as below and landing white on white, moving toward gray rather than shifting hue. Near white (every channel
above sRGB 0.9, all of it at 1) the white balance eases off to the exposure alone: a blown-out window is the
camera's white, not the room's light. (Before, white came out a shade of grey, 0.97, and took on the walls'
correction: a real home's windows were a pinkish grey.) It is per pixel, nothing spatial, and the photo spots'
photos get exactly the same adjustment, so skins and spots still agree. On unless the site asks otherwise (`"light": false`; tune with `lightTarget`,
`lightWhiteBalance`, `lightMaxGain`, `lightLift`, `lightShoulder`); the stats carry `lightGains`,
`lightExposure`, `lightWallBefore` and `lightWallSamples`, or `lightSkipped` when too few plain wall texels were
found.

### 4.9 The AI reviewer (`review.py`)

Every other AI here is a specialist (SAM cuts out, the depth model measures, TripoSG makes one shape from
one photo, LaMa fills a patch); none looks at the home and asks whether it makes sense. Claude (Opus 5.5,
through the Anthropic API, medium effort) does: shown a photo and the model rendered from the same camera
(10 sharp photos at 1024 px: first, one at a time, the photo showing the most furniture it could have made again that
no photo picked so far shows, then the rest evenly along the walk; evenly alone, a few photos can miss a piece
altogether), it lists what a buyer would notice as structured JSON,
each with a box on the render, what the thing is and whether it's a box in real life: fragments that
aren't in the photo, objects with holes or missing parts, smeared patches, wrong shapes.

* **The scan, first** (right after the loose-piece rules, §4.0): a fragment it's sure of goes if it's a
  loose piece of at most 1 m² in no RoomPlan box, with 40% of it inside the reviewer's box. Furniture it
  finds broken is made again by the furniture stage (§4.4), storage too but never storage next to a sink,
  stove or other fixture: what it says is a box in real life (a dresser, cabinet, nightstand, TV stand)
  as the box RoomPlan measured if RoomPlan filed it as storage or a table (never a sofa's or a bed's box),
  which the skins then paint from the photos, anything else by TripoSG. A box-shaped piece whose sides
  are ragged, warped or blotched (the photos painting badly onto a lumpy scan: a real dresser by a
  window) counts as incomplete, not a smear. It also says what kind of furniture it is (sofa, chair,
  bed, table, storage or none), and only RoomPlan boxes of that kind can be it (storage and tables
  stand for each other, as do sofas and chairs; none is never rebuilt): a cabinet's problem landed on
  the sofa beside it before. Which piece it means is what the model shows (each pixel's surface point
  in a RoomPlan box grown 5 cm): first, around the point it gives on the object (2% of the long side
  each way), the piece most of those pixels show; failing that, the piece at least 30% of its box
  shows, or half of which (as this view shows it) its box takes in while being 8% of it (a loose box),
  the most of both winning; only if none does, the box whose outline overlaps the reviewer's box 30%
  (IoU): a box drawn tight around a dresser's hole overlaps the dresser's outline far less than that.
  Its boxes can be off (on Sheridan, 7 of 12 problems matched nothing, a white cabinet among them though
  RoomPlan has two white storage boxes in that room), hence the point. With points, the bed, the sofa
  and the tables matched; a chair, a nightstand and a side table didn't (a box over 2% of the chair), so
  boxes and points are asked for in the render's pixels (its size given with each request), not
  thousandths. It's asked to box the whole object for these, too. Each match, where in the home its
  point lands and, when none matched, what came nearest go to the log; the furniture stage logs where
  each piece is. `check_reviewer` reports how well it aims on the made-up room (`aim`: each box's IoU with
  the truth, whether its point is on it).
* **What came of it**: each problem in `reviewFound` ends with what was done (removed; to be rebuilt as a
  box, then rebuilt or "tried, but the scan stayed"; left, and why: no furniture RoomPlan measured there,
  not a small loose piece, repainting isn't built yet). Those acted on come first, 25 at most.
* **The result, last** (after the lighting), from the same photos (no more go to it than the 10 the privacy
  page names; change both together): what it still finds goes to the stats for the dashboard.

Requests use server-side fallbacks (`fallbacks: "default"`); a refusal or an error is no issues. Stats:
`reviewIssues`, `reviewFound`, `reviewRemoved`, `reviewRemovedArea`, `reviewRebuild` (RoomPlan id: `box` or
`made`), `reviewLeft`, `reviewTokens` (input and output tokens and their list price in dollars; thinking
is output and most of it). Two passes of 10 views come to roughly 60 cents a home at medium effort
(about twice that at high). The worker's log ends with `remaster review:`, these lists and the furniture's fits. `"review": false` turns it off. It needs `ANTHROPIC_API_KEY` in the
`atrium-photoreal` Modal secret; without it the review is skipped. The legal pages name Anthropic as a
subprocessor and say what it sees. To check the key works: `modal run modal_app.py::check_reviewer` (one review of
a made-up room on a CPU, a few cents; prints what it found and the tokens, never the key).

## 5. The job (`atrium_remaster/job.py`)

```
POST REMASTER_GPU_URL   Authorization: Bearer PHOTOREAL_WORKER_SECRET
{ "jobId", "callback": "https://<site>/api/remaster/jobs/<id>",
  "files": [{ "name": "cameras.json", "url": "<signed>" }, …],     the kept photos
  "model": { "url": "<the painted model (.glb)>" },
  "options": { … REMASTER_OPTIONS … } }
```

The worker downloads everything, checks that the photos land on the model (at least half their pixels: photos of
another scan don't), runs the stages and reports to the callback with the same secret:

| Event | Answer |
|---|---|
| `{ event: "progress", stage, progress, message }` (stages, in order: `downloading`, `cleanup`, `shapes`, `furniture`, `depth`, `skins`, `fill`, `light`, `spots`, `uploading`; `progress`: how far along that stage is, 0–1; `message`: what the stage's name doesn't say) | the job |
| `{ event: "upload", files: [{ name: "spot-000.jpg", bytes }, …] }` (the photo spots, first) | `{ targets: [{ name, url, method, headers, assetUrl }] }` |
| `{ event: "upload", files: [{ name: "model.glb", bytes }] }` | `{ targets: [{ name, url, method, headers, assetUrl }] }` |
| `{ event: "done", modelUrl, stats }` | the job |
| `{ event: "failed", message }` | the job |

Options (all optional):

* Skins: `steps` (3000), `scale` (2), `maxTexels` (40 M), `longSide` (1920), `batch` (4), `tile` (768), `levels` (1),
  `maxMip` (4), `align` (true), `anneal` (0.1), `confidence` (0: off).
* Cleanup: `deblur` (true), `deblurMinSmear` (1.5 px), `deblurResidual` (0.3), `tvOff` (true), `windows` (true).
* Trim: `trim` (true: all of it), `recessDepth` (0.1 m), `baseboards`, `crowns`, `casings`, `cabinets` (true).
* Furniture: `furniture` (true), `furnitureMinFit` (0.6), `furnitureBetterBy` (0.05), `furnitureViews` (5),
  `furnitureLongSide` (960), `furnitureInFrame` (0.9), `furnitureAll` (false: with the reviewer, only its picks).
* Depth: `depth` (true), `fuse` (true). Fixer views: `fixerViews` (false), `fixerRounds` (2), `fixerViewCount` (80), `fixerWidth`
  (1024), `fixerHeight` (576), `fixerWeight` (0.5), `fixerShare` (0.25), `fixerToneLock` (0.012).
* Photo spots: `spots` (true), `spotFace` (1024), `spotSpacing` (1 m), `spotLongSide` (1920).
* `loose` (true), `review` (true), `fill` (true), `jpegQuality` (90).

The remastered model is a GLB like the phone's photo models: one unlit primitive per atlas (JPEG), the scan manifest
in the scene's extras, so the viewer loads it in place of the painted one.

**Timing.** The stats carry `totalSeconds` (download to the model's upload) and `stageSeconds`, the seconds each
stage took (`downloading`, `cleanup`, `shapes`, `furniture`, `depth`, `skins`, `fill`, `light`, `spots`, `uploading`;
a stage runs from its first progress report to the next stage's). The log prints them as `remaster stages (s): …`,
and the listing page shows them under **Time by stage**, with how long the job took from being started.

**Progress.** A stage's start is reported at once, how far along it is at most every 20 s. The site keeps how far
along the whole job is: the stages before this one, and as much of its own share as it has done. Each stage's share is
roughly its part of a job's time (`src/lib/remaster-steps.ts`: a home of a few rooms scanned with its layout, on an
A10G), and the number never goes back. The listing page shows it as one bar, with the stage's name beside it. A stage
a job skips (no layout, so no furniture) is jumped over. Retune the shares from real jobs' **Time by stage**.

## 6. AI models and licenses

Every model the remaster runs may be used commercially (checked October 2026; the full survey with sources is in the
session notes, summarized here):

| Use | Model | License |
|---|---|---|
| Fill (§3) | LaMa big-lama | Apache-2.0 (code; weights from its authors) |
| Ray casting, meshes, cutting walls | Open3D 0.20, xatlas, shapely, mapbox-earcut | MIT; MIT; BSD-3; ISC |
| Deblur (§4.1) | NAFNet (REDS weights) | MIT |
| Cutouts (§4.4) | SAM 2.1 (Hiera-L, through transformers) | Apache-2.0 |
| Depth (§4.3) | Prompt Depth Anything (ViT-L) | Apache-2.0 |
| Furniture shapes (§4.4) | TripoSG, with its marching-cubes decoder (scikit-image) | MIT; BSD-3 |
| Views (§4.2) | NVIDIA Fixer | NVIDIA Open Model License |

Kept out on purpose: nvdiffrast, nvdiffrec, diffoctreerast and the Inria Gaussian rasterizer (non-commercial);
TRELLIS, whose mesh step is NVIDIA's FlexiCubes (Kaolin ships it under its non-commercial license, and TRELLIS's
copy carries NVIDIA's all-rights-reserved notice); RMBG 1.4/2.0 (non-commercial background removers); diso (TripoSG's
fast mesher: stubbed out) and cubvh (provenance); FLUX.1 [dev] (non-commercial); Hunyuan3D (territory and user
limits); Depth Pro and UniDepth (research only); and GPL/AGPL mesh tools (pymeshfix, pymeshlab, igraph).

## 7. Set it up

1. **Modal**: the remaster shares the photoreal worker's secret (`atrium-photoreal`, docs/photoreal.md §5.1). Deploy:

   ```sh
   cd worker/remaster
   modal deploy modal_app.py          # REMASTER_GPU=L4 modal deploy … for a cheaper, slower GPU
   ```

   It prints the `start` endpoint's URL (`https://<workspace>--atrium-remaster-start.modal.run`, on some workspaces
   with a region before `.modal.run`, e.g. `.us-east.modal.run`): copy it as printed.
2. **The site** (Vercel → Settings → Environment Variables), then redeploy:

   | Name | Value |
   |---|---|
   | `REMASTER_GPU_URL` | the `start` URL from the deploy |
   | `REMASTER_OPTIONS` | optional JSON the worker gets as its options, e.g. `{"steps": 3000}` |

3. **Database**: `supabase/migrations/20261014000000_remaster.sql` adds `tours.remaster_url`, the `remaster_jobs`
   table (owners read their jobs; the server writes them) and the `remastered` look. Open `/setup`, or the site adds
   it on first use when it can reach Postgres directly.

A job costs the GPU's time: with the defaults, about 6 minutes on an A10G for the synthetic apartment's 665 photos
(the skins half of it, AI depth most of the rest); the Fixer's views, when turned on, add a few minutes and a second
GPU.

## 8. Develop and test

```sh
cd worker/remaster
python -m pytest tests -q        # CPU, 75 tests (below)
modal run modal_app.py::remaster_folder --capture <folder> --model <painted.glb> --out <folder>   # the stages on a GPU
modal run modal_app.py::make_shape --image <photo> --box x0,y0,x1,y1 --out <folder>             # SAM 2.1 + TripoSG on one piece
```

The tests need `open3d-cpu` (and, on Linux, `libegl1`, `libgl1` and `libusb-1.0-0`), `xatlas`, `shapely` and
`mapbox-earcut` next to the photoreal worker's requirements; `tests/room.py` makes the synthetic room (walls, floor,
ceiling, a cabinet, photos from inside with different exposures). They cover the model file, ray casting, the skins
(and that their coverage count and tile warps match the straightforward way), the fill, cleanup, depth and its
fusion, the shape edits, trim, furniture fitting, photo spots and the job against a stand-in site. The AI models
themselves are stand-ins there; their real runs are on Modal.

On the GPU, the photos' training views take 15 bytes a pixel; when they'd take more than 40% of its free memory
(hundreds of full-size photos), they wait in pinned memory and each step moves only its tiles (`skinViewsOn` in the
job's stats says which).

The site's flow (Remaster with AI, progress, the photo spots' and model's uploads, done, the look, the preview switch,
photos kept while a remaster uses them) was checked end to end on a production build with stand-in GPUs, and the
Supabase store against Postgres + PostgREST with row-level security. The viewer's photo spots were checked in
Chromium on a remastered synthetic room: WebGL samples the cubes as the worker lays them out, the photos show at a
spot and the skins away from it, with no shader errors. The one-spot viewer was checked in Chromium against the
two-spot one on a room whose model leaves out a painting standing 35 cm from its wall and a box on the floor (the
spots' cubes of the real room, the skins 48 photos' average through the model): the painting shows once where it
showed twice, exactly as photographed at a spot, and fine detail (wallpaper stripes) as sharp as before.
