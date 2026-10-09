# Photoreal walkthroughs

A photoreal walkthrough shows the home the way the scan's photos saw it: window views, reflections,
plants, the texture of a sofa. It is made from the same photos the phone paints onto the 3D model, by
a cloud GPU that trains 3D Gaussian splats on them (20–35 minutes). Buyers switch to it with the
**Photoreal** button in the walkthrough, and the realtor can make it the look buyers start with. The
painted model stays loaded underneath: it does the walking, floors and sight lines, and it is what
shows until the splats arrive or if they can't load.

Pieces:

| Where | What |
|---|---|
| Phone (`ios/`, build 9 on) | Every photo scan writes `photoreal/` (§1). After the scan is sent, **Make it photoreal** uploads it with the photos |
| Site (`src/lib/photoreal.ts`, `src/app/api/…/photoreal`) | Jobs (`photoreal_jobs`), signed uploads to the private `photoreal` bucket, hands the job to the GPU, takes the worker's reports, attaches the splats to the tour, deletes the photos |
| GPU worker (`worker/photoreal`, on [Modal](https://modal.com)) | Downloads the job, trains, writes `.spz`, uploads it, reports back |
| Viewer (`src/components/tour/TourScene.tsx`) | Loads the `.spz` with [Spark](https://sparkjs.dev) 2.2.0 the first time Photoreal is switched on; hands over to the painted model up close and away from where the photos were taken (§4) |

## 1. What the phone uploads (`atrium-photoreal/1`)

Written by `PhotorealExport.swift` with each build (and `scanproc paint … --photoreal <dir>`), into the scan's
`photoreal/` folder; the photos stay in `frames/`.

* **`cameras.json`**: `format`, `convention`, the model's `bounds`, its `rooms`, and per photo (`frames`)
  the `file` (`frames/000012.jpg`), `width`/`height`, intrinsics `fx fy cx cy` at that size, `exposure`, `turnRate`,
  and `pose`: 16 numbers, column-major, the ARKit camera-to-world (x right, y up, looking down −z) **in the model's
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
   answer, the job waits in `queued` with the reason, and the dashboard can start it later.
   `GET …/photoreal/{jobId}` tells the phone how it is doing.
3. **Worker → site**: `POST /api/photoreal/jobs/{id}` with `Authorization: Bearer PHOTOREAL_WORKER_SECRET`:
   * `{ event: "progress", stage, progress, message }`: stages `starting`, `downloading`, `training`, `uploading`;
   * `{ event: "upload", bytes }` → `{ url, method, headers, assetUrl }`: where to PUT the `.spz` (stored next to the
     tour's other files);
   * `{ event: "done", assetUrl, stats, spots }`: the site attaches the splats to the tour (`tours.splat_url`, and
     `tours.splat_spots`: where each photo was taken, `[x, y, z, yaw, pitch]` in meters and radians in the model's
     frame, yaw 0 looking along −z), marks the job `done` and deletes the photos (they stay on the phone);
   * `{ event: "failed", message }`: the job is `failed`; the photos stay, and **Try again** in the dashboard hands
     them to the GPU again.
4. **Dashboard** (listing page): the job's state, live; **Start** / **Try again**; when done, how big and how long.
   **Rooms & viewpoints** offers *Photoreal* as the starting look.

Sending the scan again replaces the listing's model, so it drops the splats too (and a job still running for the
old model finishes without attaching them). Make the new scan photoreal again.

## 3. Training (`worker/photoreal`)

gsplat 1.5.3's recipe: MCMC on the GPU (up to 1,000,000 splats), 30,000 steps on photos 1440 pixels on their long
side, loss 0.8 L1 + 0.2 (1 − SSIM), spherical harmonics up to degree 3. Splats start as flat discs on the seeds, facing
the surface. gsplat tunes MCMC for scenes scaled so the cameras sit about a unit from their center; homes are in
meters, so its position noise (which grows with the square of the unit) and scale penalty are sized to the capture
(`TrainConfig.normalize`). Unsized, a whole apartment got about ten times a bedroom's noise and never converged.

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

## 4. In the walkthrough

Splats are at their best near where the photos were taken, so the viewer shows them there and the painted model
elsewhere (`SplatLayer` in `TourScene.tsx`). A few times a second it casts nine rays across the view: if most of
what is in view is within 0.9 m, or (when the tour has its photo spots) no photo was taken within 1.4 m of the
camera looking within 70° of the same way, the splats fade out over a third of a second and the painted model
shows; they come back from 1.15 m, or within 1.05 m and 55° of a photo spot. The first time, a hint says why
("Up close: the photos painted on the model"), and the Photoreal button's ring dims while it waits. Tours made
before the spots were reported go by distance alone.

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

Then redeploy. The worker reaches the site at `NEXT_PUBLIC_SITE_URL` (or the address the phone used), so it must be
a public HTTPS address: a dashboard on a laptop can take uploads from a phone on the same Wi-Fi, but a cloud GPU
can't download from it.

### 5.3 Database and storage (Supabase)

`supabase/migrations/20261010000000_photoreal.sql` adds `tours.splat_url`, the `photoreal_jobs` table (owners can
read their jobs; the server writes them) and the private `photoreal` bucket; `20261011000000_photoreal_spots.sql`
adds `tours.splat_spots`. Open `/setup` on the site, or apply them with the other migrations; the site also adds
what's missing on first use when it can reach Postgres directly. Without `splat_spots` the splats still attach,
and the viewer goes by distance alone.

Supabase's free plan takes files up to **50 MB** (Storage → Settings): photos are 1–3 MB each and the splats are
kept under 45 MB, so the defaults fit.

### 5.4 Without Supabase (local data folder)

Everything works with the local store too: the photos go to `<data>/uploads/<user>/<listing>/photoreal-<job>/`,
readable only through the signed links the GPU gets, and are deleted when the splats arrive.

## 6. Costs and sizes

* **GPU**: 20–35 minutes on an A10G (about $1.10 an hour on Modal): roughly $0.40–0.70 per home. Nothing runs
  between jobs.
* **Upload from the phone**: the photos, 100–400 MB for a home (best on Wi-Fi). They are deleted from storage once
  the splats exist.
* **Download for buyers**: the `.spz`, at most 45 MB, only when they switch to Photoreal (or start in it).

## 7. Status and limits

* Checked end to end on this repo's synthetic apartment, with a stand-in for the GPU (the same worker code on a CPU,
  tiny images): the phone's upload code (run on Linux against the site), the site, the job, the callback, the
  splats on the tour. In a browser, splats made from the export's own seed points sit exactly on the painted model
  and keep its colors (to 1–3 levels). Not yet run on a real GPU or a real home.
* Splats are weakest where no photo looked closely: a spot the phone only saw from far away or from above can show
  haze when a buyer walks right up to it. A scan whose coverage map is green everywhere gives the GPU the most to
  learn from.
* The pairing code lasts 24 hours; to make an older scan photoreal, connect the phone to the listing again.

## 8. Develop and test

```sh
cd worker/photoreal
pip install -r requirements.txt pytest
python -m pytest tests -q                          # conventions, .spz, a small training run, the job protocol
python run_local.py <capture dir> <out dir> --cpu --steps 200 --long-side 64   # a tiny run on a CPU
```

`ios/ci/mock_atrium_server.py` takes a photoreal upload like the site does; the simulator test in CI sends a
rebuilt scan with photos and makes it photoreal against it.
