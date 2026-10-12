# Photoreal walkthroughs

A photoreal walkthrough shows the home the way the scan's photos saw it: window views, reflections,
plants, the texture of a sofa. It is made from the same photos the phone paints onto the 3D model, by
a cloud GPU that trains 3D Gaussian splats on them (35–50 minutes). Buyers switch to it with the
**Photoreal** button in the walkthrough, and the realtor can make it the look buyers start with. Each job makes a
faithful version and an AI-enhanced one (§3.1), and the realtor picks which buyers see. The
painted model stays loaded underneath: it does the walking, floors and sight lines, and it is what
shows until the splats arrive or if they can't load.

Pieces:

| Where | What |
|---|---|
| Phone (`ios/`, build 9 on) | Every photo scan writes `photoreal/` (§1). After the scan is sent, **Make it photoreal** uploads it with the photos |
| Site (`src/lib/photoreal.ts`, `src/app/api/…/photoreal`) | Jobs (`photoreal_jobs`), signed uploads to the private `photoreal` bucket, hands the job to the GPU, takes the worker's reports, attaches the splats to the tour, keeps the photos for training again (§2.1) |
| GPU worker (`worker/photoreal`, on [Modal](https://modal.com)) | Downloads the job, trains, writes `.spz`, uploads it, reports back |
| Viewer (`src/components/tour/TourScene.tsx`) | Loads the `.spz` with [Spark](https://sparkjs.dev) 2.2.0 the first time Photoreal is switched on; hands over to the painted model up close and away from where the photos were taken (§4) |

## 1. What the phone uploads (`atrium-photoreal/1`)

Written by `PhotorealExport.swift` with each build (and `scanproc paint … --photoreal <dir>`), into the scan's
`photoreal/` folder; the photos stay in `frames/`.

* **`cameras.json`**: `format`, `convention`, the model's `bounds`, its `rooms`, and per photo (`frames`)
  the `file` (`frames/000012.jpg`), `width`/`height`, intrinsics `fx fy cx cy` at that size, `exposure`, `turnRate`,
  `speed` (build 11 on: how fast the phone was moving, m/s) and `pose`: 16 numbers, column-major, the ARKit camera-to-world (x right, y up, looking down −z) **in the model's
  frame**, as painted after the photos were lined up (`PoseRefinement`). So the splats come out in the frame of the
  `.glb` the listing shows, and need no alignment. OpenCV camera-to-world = `pose · diag(1, −1, −1, 1)`.
* **`seeds.ply`**: where training starts. Binary little-endian, per point `float x y z nx ny nz` and
  `uchar red green blue` (27 bytes): points every 3 cm (`seeds.spacing`) on the painted surfaces a photo saw, in
  their painted colors, at most 600,000.
* **`masks/<photo>.png`**: where a photo shows people (white). Training ignores those pixels.

## 2. Flow

1. **Phone → site.** `POST /api/capture/sessions/{token}/photoreal` with `{ files: [{ name, size }], assetUrl }`
   creates a job (`uploading`) and answers `{ jobId, uploads: [{ name, method: "PUT", url, headers }] }`. `assetUrl`
   is the model the phone sent for this scan; if the listing shows another scan's model now, the answer is 409 (the
   photos wouldn't line up with it). The site checks the names (`cameras.json`, `seeds.ply`, `frames/…`, `masks/…`),
   at least 10 photos, ≤ 64 MB per file, ≤ 4 GB in all. The phone PUTs every file, four at a time, each tried up to
   three times.
2. **`POST …/photoreal/{jobId}`**: the site lists what arrived; if everything is there the job is `queued` and
   handed to the GPU (`PHOTOREAL_GPU_URL`, with the shared secret): `{ jobId, callback, files: [{ name, url }] }`,
   download links valid for 24 hours. If the GPU takes it the job is `running`; if no GPU is set up, or it doesn't
   answer, the job waits in `queued` with the reason, and the dashboard can start it later. With billing on and
   photoreal not yet paid for on this listing ([billing.md](billing.md)), the job also waits in `queued`: the
   listing page offers **Add photoreal**, and paying starts it. The phone only says it's waiting, never a price.
   `GET …/photoreal/{jobId}` tells the phone how it is doing.
3. **Worker → site**: `POST /api/photoreal/jobs/{id}` with `Authorization: Bearer PHOTOREAL_WORKER_SECRET`:
   * `{ event: "progress", stage, progress, message }`: stages `starting`, `downloading`, `training`, `uploading`;
   * `{ event: "upload", bytes }` → `{ url, method, headers, assetUrl }`: where to PUT the `.spz` (stored next to the
     tour's other files);
   * `{ event: "done", assetUrl, stats, spots }`: the site attaches the splats to the tour (`tours.splat_url`, and
     `tours.splat_spots`: where each photo was taken, `[x, y, z, yaw, pitch]` in meters and radians in the model's
     frame, yaw 0 looking along −z) and marks the job `done`. The photos stay in storage (§2.1);
   * `{ event: "failed", message }`: the job is `failed`; the photos stay, and **Try again** in the dashboard hands
     them to the GPU again.
4. **Dashboard** (listing page): the job's state, live; **Start** / **Try again**; when done, how big and how long,
   and **Train again** (§2.1). **Rooms & viewpoints** offers *Photoreal* as the starting look.

### 2.1 Photos kept for training again

A listing's photos stay in the `photoreal` bucket after training, so it can be trained again without a rescan: when
the trainer improves, or for another version of the splats. **Train again** on the listing page makes a new job
from them (`photoreal_jobs.inputs_job_id` names the job whose upload they came with, and so their folder), hands it
to the GPU, and buyers keep seeing the current walkthrough until the new one is ready. A job that finishes after a
newer one of the same scan doesn't replace its splats. Photoreal paid for once covers
it ([billing.md](billing.md)). A listing keeps one set of photos:

* a newer upload from the phone replaces them once it has arrived (older scans' photos no longer match the model;
  photos a job still waits for or trains on are left alone until it finishes);
* **Delete the photos** on the listing page deletes them (the walkthrough stays);
* deleting the listing deletes them.

`photoreal_jobs.inputs_deleted_at` notes when an upload's photos went. Jobs finished before photos were kept had
theirs deleted: those listings say so and point to **Make it photoreal again** in the app, which sends them again.

Sending the scan again replaces the listing's model, so it drops the splats too (and a job still running for the
old model finishes without attaching them). Make the new scan photoreal again.

## 3. Training (`worker/photoreal`)

gsplat 1.5.3's recipe: MCMC on the GPU (up to 1,000,000 splats), 30,000 steps on the photos at full size (1920 pixels
on their long side, as the phone saves them; the first workers trained at 1440 and lost a quarter of the detail),
loss 0.8 L1 + 0.2 (1 − SSIM), spherical harmonics up to degree 3. Splats start as flat discs on the seeds, facing
the surface. gsplat tunes MCMC for scenes scaled so the cameras sit about a unit from their center; homes are in
meters, so its position noise (which grows with the square of the unit) and scale penalty are sized to the capture
(`TrainConfig.normalize`). Adam moves only the splats the current photo shows (gsplat's `SelectiveAdam`,
`TrainConfig.visible_adam`): with plain Adam, a splat no photo has shown lately, such as one MCMC just placed, gets
the regularizers' small pushes at full step size and dies before a photo sees it. In a whole home, where each room is
out of view most of the time, rooms were forgotten faster than they were learned.

On top of the recipe, for phone photos: a gain and an offset per color channel and photo for the phone's auto
exposure and white balance, averaging to none over all the photos so the splats keep the photos' average look (a full
color matrix per photo, as first deployed, let color drift between the splats and the corrections until one channel
carried all of it: right in training, red or white in the viewer); small pose corrections per photo; people's pixels
left out; and nothing grows more than 5 m outside the model. The `.spz` (version 3) is kept under 45 MB (`options.maxMB`): if it would be bigger, the highest
view-dependent color bands are dropped until it fits. `stats` reports splats, steps, size, minutes and the training
PSNR.

**The room's shape** (`shell.py`). Photos only say what a surface looks like from where they were taken, so a
splat can sit wherever that looks right from those spots: from closer, or from the side, it shows as a smear, a
needle or a blob hanging off a wall. Training keeps three rules on top of the recipe:

* splats within 2.5 cm of a wall, floor or ceiling are put on it, lying flat in it, at most 2 mm thick. The planes
  are the rooms' walls, floors and ceilings in `cameras.json`, each checked against the seeds: a plane counts where
  seeds lie on it facing the same way (the seeds' median says exactly where it is), so an outline edge between two
  open rooms, a doorway and a window are left alone;
* no splat is more than 6 times longer than it is wide;
* splats hanging in the air within 30 cm of where a photo was taken, away from every painted surface, are cleared
  (what a photo explains with something right in front of the lens).

`stats` adds `shellPlanes`, `onShell` (splats on them at the end) and `floatersCleared`.

**Smeared photos** (`sharpness.py`). A photo taken while the phone turns is smeared by about turn rate × exposure ×
focal length pixels (plus speed × exposure × focal length ÷ 1.5 m for walking): indoors the camera runs at its longest
exposure (1/60 s), where a slow 0.2 rad/s turn smears 5 px across a 1920 px photo, and builds before 11 also took
photos while the phone kept moving. Trained on every photo as it is, the splats average the smeared photos in and come
out soft, while the painted model takes each spot from its sharpest photo. So a photo smeared 1 px or more (at training
size, from `cameras.json`'s `turnRate`, `speed` and `exposure`) is compared with the render smeared the same way: a
line as long as its smear, in the direction that matches it best, found by trying twelve at steps 4,000 and 12,000
(before that the splats are still taking shape, and the photo is used as it is). A smeared photo still says where
things are and what color they are, but no longer pulls the splats soft (`TrainConfig.blur_model = "kernel"`).

The first attempt drew smeared photos less often where sharper photos saw the same surfaces (`blur_model = "sample"`:
a say of (sharpest smear there + 1 px) / (its smear + 1 px), photos drawn in proportion to say²). On the synthetic
apartment with half its photos smeared (round 4, `prototypes/photoreal/results/round-4/`) that was a little crisper
(LPIPS 0.01–0.02 better) but lost 0.2–0.6 dB, and edges seen from few sides, with fewer photos holding them, ghosted (a
door frame). Matching smeared photos instead (round 5, `results/round-5/`) stays within 0.3 dB of taking them as they
are, keeps most of the LPIPS gain (at the photo spots 0.173, against 0.189 as they are and 0.169 drawn less often), costs
no time, and leaves the door frame as clean as before. The synthetic apartment is mostly flat walls, though, and its
photos are 480 px across: a real, textured scan at 1920 px is the real test. `stats` adds `smearPx` (median, 90th percentile, largest, at training size), `blurModel`,
`smearedPhotosMatched` and, with "sample", `photosLeftToSharper`.

### 3.1 The AI-enhanced version (`enhance.py`)

Every job makes two versions of the splats from the same photos, so the realtor can see which looks better and
choose what buyers see:

* **Faithful**: the training above, only what the photos show. Delivered first, as before.
* **AI-enhanced**: training goes on for 4,500 more steps with a diffusion model in the loop. Between and around the
  photo spots the splats have to guess, and the guesses show as haze, smears, floaters and holes. NVIDIA's
  [Fixer](https://huggingface.co/nvidia/Fixer) (Cosmos-Predict2's 0.6B image model, trained to turn a render of a 3D
  reconstruction into a clean picture in one denoising step; the commercially licensed successor of
  [Difix3D+](https://research.nvidia.com/labs/toronto-ai/difix3d/)) looks at the splats from where buyers walk and
  cleans each view up, and the splats then train on the cleaned views next to the photos.

The views: up to 120, each starting at a photo's spot and ending 0.25–1 m away across the room at eye height (1.35–1.65 m
above the room's floor), turned up to 35°, nearly level, 1024 × 576 (Fixer's size) with a 75° field of view; each
ends clear of every surface the photos saw (0.3 m) and gets there without passing through or brushing past one. Three
rounds of 1,500 steps: round *r* renders the views *r*/3 of the way from their photo to where they end, has the Fixer
clean them up, and adds them to the training (Difix3D+'s progressive distillation: each clean-up only has a little
to fix, so the cleaned views agree with each other). A cleaned view is drawn on 30% of the steps and counts half as
much as a photo; dead splats may move again (MCMC relocation) to where the cleaned views want something. The cleaned
views are compared with the splats' own colors, with no photo's exposure correction or smear.

What it costs and risks: about 10–15 more minutes on the trainer's A10G and a few on the Fixer's (one A10G of its own,
kept up between rounds, shared by jobs at the same time), about $0.25 a home. Where the photos say nothing, the cleaned
views make something up: the AI version can tidy a corner that wasn't tidy or invent a little texture. That's why both
are kept and the realtor picks.

Flow: the site asks for it (`options.aiVersion`, unless `PHOTOREAL_AI_VERSION=off`); a worker from before it ignores
the ask. After the faithful splats are `done` with `pending: ["ai"]`, the worker reports `{ event: "progress",
variant: "ai" }`, uploads `splats-ai.spz` (`{ event: "upload", variant: "ai" }`) and ends with `{ event: "variant",
name: "ai", status: "done", assetUrl, stats }` or `status: "failed"` (the faithful version stays either way). The job
keeps it in `photoreal_jobs.variants.ai`. The listing page shows it on its way, then **Faithful | AI-enhanced** to pick
what buyers see (`tours.splat_url`); the realtor's preview has the same switch next to **Photoreal** (in a row of its
own on a phone), and buyers only ever see the chosen one. `stats` adds `variant`, `fixer`, `aiViews`, `aiRounds`,
`aiSteps`, `aiCleanedViews` and `aiSeconds`.

The Fixer runs in its own Modal image (`atrium_photoreal/remote.py`): Cosmos-Predict2 1.0.9 on PyTorch 2.6 with
NVIDIA's prebuilt CUDA wheels (the versions of NVIDIA's Cosmos container, which needs an NGC login), the
[Fixer repository](https://github.com/nv-tlabs/Fixer) at a fixed commit (Apache 2.0) and its weights (about 5.5 GB,
NVIDIA Open Model License: commercial use allowed). The first deploy builds it, which takes a while. Difix3D+ itself
is for non-commercial use only, so it isn't used.

## 4. In the walkthrough

Splats are at their best near where the photos were taken, so the viewer shows them there and the painted model
elsewhere (`SplatLayer` in `TourScene.tsx`). A few times a second it casts nine rays across the view: if most of
what is in view is within 0.9 m, or (when the tour has its photo spots) no photo was taken within 1.4 m of the
camera looking within 70° of the same way, the splats fade out over a third of a second and the painted model
shows; they come back from 1.15 m, or within 1.05 m and 55° of a photo spot. The first time, a hint says why
("Up close: the photos painted on the model"), and the Photoreal button's ring dims while it waits. Tours made
before the spots were reported go by distance alone.

Spark draws the splats as the trainer drew them: gsplat's classic mode widens each splat by 0.3 px² on screen
(Spark's `preBlurAmount`), and nothing more (`blurAmount` 0; Spark's default of 0.3 is for anti-aliased training and
would widen them a second time and dim the smallest, softening fine texture).

## 5. Set it up

### 5.1 Modal (the GPU)

1. Make a free account at [modal.com](https://modal.com) (the Starter plan includes $30 of compute a month).
2. Create a token: Modal → Settings → API Tokens → **New token**. On your computer, `pip install modal` and
   `modal token set --token-id … --token-secret …` (or `modal setup`). For a Claude Code cloud session, put them in
   the environment's settings as `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` instead (never in a chat).
3. Pick a secret the site and the worker share, e.g. `openssl rand -hex 32`, and store it on Modal:

   ```sh
   modal secret create atrium-photoreal PHOTOREAL_WORKER_SECRET=<the secret>
   ```

4. Deploy:

   ```sh
   cd worker/photoreal
   pip install modal fastapi
   modal deploy modal_app.py          # PHOTOREAL_GPU=L4 modal deploy … for a cheaper, slower GPU
   ```

   Behind an HTTPS proxy (a Claude Code cloud session, a company network), install
   `'modal[api-proxy-support]'` instead: Modal's client only goes through `HTTPS_PROXY` with it, and
   otherwise reports "Could not connect to the Modal server".

   It prints the URL of the `start` endpoint (`https://<workspace>--atrium-photoreal-start.modal.run`).

### 5.2 The site

In Vercel → the project → Settings → Environment Variables (Production), add:

| Name | Value |
|---|---|
| `PHOTOREAL_GPU_URL` | the `start` URL from the deploy |
| `PHOTOREAL_WORKER_SECRET` | the same secret as on Modal (at least 16 characters) |
| `PHOTOREAL_AI_VERSION` | optional: `off` makes the faithful version only (§3.1) |

Then redeploy. The worker reaches the site at `NEXT_PUBLIC_SITE_URL` (or the address the phone used), so it must be
a public HTTPS address: a dashboard on a laptop can take uploads from a phone on the same Wi-Fi, but a cloud GPU
can't download from it.

### 5.3 Database and storage (Supabase)

`supabase/migrations/20261010000000_photoreal.sql` adds `tours.splat_url`, the `photoreal_jobs` table (owners can
read their jobs; the server writes them) and the private `photoreal` bucket; `20261011000000_photoreal_spots.sql`
adds `tours.splat_spots`; `20261013000000_photoreal_versions.sql` adds `photoreal_jobs.inputs_job_id`,
`inputs_deleted_at` (§2.1) and `variants` (other versions of the splats from the same photos). Open `/setup` on the site, or apply them with the other migrations; the site also adds
what's missing on first use when it can reach Postgres directly. Without `splat_spots` the splats still attach,
and the viewer goes by distance alone.

Supabase's free plan takes files up to **50 MB** (Storage → Settings): photos are 1–3 MB each and the splats are
kept under 45 MB, so the defaults fit.

### 5.4 Without Supabase (local data folder)

Everything works with the local store too: the photos go to `<data>/uploads/<user>/<listing>/photoreal-<job>/`,
readable only through the signed links the GPU gets, and kept like in Supabase (§2.1).

## 6. Costs and sizes

* **GPU**: 30–50 minutes on an A10G at full-size photos (about $1.10 an hour on Modal): roughly $0.55–0.90 per
  home, and about $0.25 more for the AI-enhanced version (§3.1). Nothing runs between jobs.
* **Upload from the phone**: the photos, 100–400 MB for a home (best on Wi-Fi).
* **Storage**: each listing keeps its latest photos, 100–400 MB, for training again (§2.1). Supabase's free plan
  holds 1 GB in all (tours, splats and photos together), a few homes' worth; Pro includes 100 GB, a few hundred.
  **Delete the photos** frees a listing's.
* **Download for buyers**: the `.spz`, at most 45 MB, only when they switch to Photoreal (or start in it).

## 7. Status and limits

* Checked end to end on this repo's synthetic apartment, with a stand-in for the GPU (the same worker code on a CPU,
  tiny images): the phone's upload code (run on Linux against the site), the site, the job, the callback, the
  splats on the tour. In a browser, splats made from the export's own seed points sit exactly on the painted model
  and keep its colors (to 1–3 levels).
* **On the GPU, on the synthetic apartment** (rough capture, evaluation views it wasn't trained on): photoreal beats
  the build 9 painted model on PSNR and SSIM for every kind of view, e.g. 26.75 vs 25.75 dB at 1.2 m from a wall
  and 22.61 vs 21.08 dB at the photo spots. On LPIPS the painted model's crisp textures still win close to walls
  (0.238 vs 0.269 at 1.2 m), and the splats win at the photo spots (0.161 vs 0.215). That's why the walkthrough
  shows photoreal around the photo spots and the painted model up close (§4). The full table is in
  `prototypes/photoreal/results/round-3/painted-vs-photoreal.md`. 16 views into a mirror are left out: the
  reference renderer draws that reflection differently from one render to the next.
* **First real home** (2026-10-10, worker `b8c7d79`): a bedroom scan with 199 photos at 1440 px trained in 24 minutes
  on an A10G (about $0.45). That was 30,000 steps to 1,000,000 splats, with training PSNR rising steadily to 28.1.
  The earlier trainer's collapse after a few thousand steps is gone. The room-shape rules found 10 walls plus the
  floor and ceiling, and cleared 159 floaters.
* **The AI-enhanced version** (§3.1) is checked on a CPU with a stand-in for the Fixer (a median filter): views where
  they belong, the faithful version identical with and without it, the job protocol, the site's panel, choice and
  preview switch (end to end on a production build). It hasn't run with the real Fixer on a GPU yet: that's the
  benchmark on the synthetic apartment (`tools/eval_modal.py --variants ai,ai-strong`) and then real homes.
* Splats are weakest where no photo looked closely: a spot the phone only saw from far away or from above can show
  haze when a buyer walks right up to it. A scan whose coverage map is green everywhere gives the GPU the most to
  learn from.
* The pairing code lasts 24 hours; to make an older scan photoreal, connect the phone to the listing again.

## 8. Develop and test

```sh
cd worker/photoreal
pip install -r requirements.txt pytest
python -m pytest tests -q                          # conventions, .spz, a small training run, the job protocol, the AI version
python run_local.py <capture dir> <out dir> --cpu --steps 200 --long-side 64   # a tiny run on a CPU
modal run modal_app.py::fixer_smoke --images <folder of renders> --out <folder>   # the Fixer alone, on a GPU
```

`ios/ci/mock_atrium_server.py` takes a photoreal upload like the site does; the simulator test in CI sends a
rebuilt scan with photos and makes it photoreal against it.
