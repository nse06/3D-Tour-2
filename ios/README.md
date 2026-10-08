# Atrium Capture — scan a home with your iPhone

Atrium Capture walks you through a home room by room. Apple's RoomPlan measures each room with
the iPhone's LiDAR scanner (walls, doors, windows, furniture), the app records the path you walk
between rooms, and turns it all into the 3D walkthrough Atrium shows buyers — rooms, floor plan,
viewpoints and the route between them, built automatically. One tap sends it to your listing.

**You need:** an iPhone with LiDAR (iPhone 12 Pro / Pro Max or any newer **Pro** model; iPad Pro
2020 or newer also works) on iOS 17 or later, and the Atrium dashboard running somewhere the
phone can reach — your Vercel deployment (works from anywhere) or the dev server on the same Wi‑Fi.

---

## 1. Install the app (no Mac required)

GitHub builds the app on every change (Actions → **iOS capture app**). Pick one way to put it on
your phone:

### Option A — Sideloadly (free; needs a Windows PC or Mac for five minutes)

1. Download the app: GitHub → **Actions** → **iOS capture app** → the latest green run →
   **Artifacts** → `AtriumCapture-unsigned-ipa`. Unzip it to get `AtriumCapture-unsigned.ipa`.
2. Install [Sideloadly](https://sideloadly.io). On Windows, also install iTunes from apple.com
   (not the Microsoft Store version) so the PC can talk to the iPhone.
3. Connect the iPhone with a cable and tap **Trust** on the phone.
4. Drag the `.ipa` into Sideloadly, enter your Apple ID, press **Start**.
5. On the iPhone: **Settings → General → VPN & Device Management** → trust your Apple ID; then
   **Settings → Privacy & Security → Developer Mode → On** (the phone restarts).

With a free Apple ID the app runs for 7 days; re-run Sideloadly to renew (your scans stay on the
phone). AltStore works the same way if you prefer it.

### Option B — TestFlight (no computer at all; Apple Developer Program, $99/year)

1. Enroll at [developer.apple.com/programs](https://developer.apple.com/programs/).
2. In [App Store Connect](https://appstoreconnect.apple.com): **Users and Access → Integrations →
   App Store Connect API** → create a key with **Admin** access. Note the **Key ID** and **Issuer
   ID** and download the `.p8` file (you can only download it once).
3. Find your **Team ID** at [developer.apple.com/account](https://developer.apple.com/account) →
   Membership details.
4. In this GitHub repository: **Settings → Secrets and variables → Actions**
   * secrets: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (paste the whole `.p8` file);
   * variable: `BUNDLE_ID` — something unique to you, e.g. `com.yourname.atriumcapture`.
5. **Actions → iOS TestFlight → Run workflow.** The first run registers the app ID with Apple.
6. App Store Connect → **Apps → + → New App**: iOS, any unique name ("Atrium Capture – Your Name"),
   pick your bundle ID, any SKU. If the first upload stopped because the app didn't exist yet,
   run the workflow again.
7. Install **TestFlight** on the iPhone. In App Store Connect → your app → **TestFlight → Internal
   Testing**, add yourself; open the invite on the phone and install. New builds arrive the same way.

## 2. Connect the app to a listing

1. In the Atrium dashboard open a listing (or create one and choose **Scan with iPhone**).
2. Click **Connect an iPhone**. A QR code appears.
3. Point the iPhone's **Camera** at the code and tap **Open in Atrium Capture** (or use **Scan
   pairing code** inside the app, or copy the link to the phone and **Paste pairing link**).
4. The app shows **Connected — scans will go to *your listing***. The code works for 24 hours.

Using a dev server on your computer instead of Vercel? Keep the iPhone on the same Wi‑Fi and
allow **Local Network** access when the app asks. On Vercel, open the dashboard on your
production address (`your-project.vercel.app`): preview deployments are behind Vercel's login,
which the phone can't pass.

## 3. Scan your home

* **Before you start:** turn on the lights, open interior doors and blinds. Begin in the entry or
  the living room. The photos the phone takes while you scan are painted onto the walls, floors,
  ceilings and furniture of the walkthrough, so tidy up what buyers shouldn't see. People are
  painted out — you in a mirror, someone walking through — as long as the phone also saw those
  spots without them; someone who stays put in one place for the whole scan stays in it.
* Tap **Start a scan**. Move slowly along the walls, pointing at the edges where walls meet the
  floor and ceiling, at windows, doors and large furniture. RoomPlan shows what it has measured
  and coaches you ("Move closer to the wall", "Slow down").
* When the outline of the room is complete, tap **Done with this room** and give it a name — the
  app suggests one when RoomPlan recognises a kitchen, bedroom, bathroom…
* Tap **Scan the next room** and **walk** to it with the phone held up and pointing ahead: that
  walk becomes the route buyers glide along. Tap **Start scanning room N** once you're inside,
  ideally standing still for a moment as you tap. RoomPlan starts every room in its own
  coordinate frame; the app lines the rooms up again afterwards from RoomPlan's merged layout and
  your walk, so keep the app open and the camera uncovered between rooms.
* After the last room tap **Finish and build the tour**. The phone combines the rooms and builds
  the walkthrough (15–90 seconds).
* Open the scan and tap **Send to Atrium**. The listing page in the dashboard updates by itself;
  use **Walk through it** to preview, adjust room names or viewpoints in **Rooms & viewpoints**,
  then **Publish**.

Tips: one RoomPlan "room" can be up to about 9 × 9 m — scan a large open space as two rooms.
Scanning is demanding: a full apartment is fine, but if the phone gets hot it pauses; let it cool.

Furniture and clutter keep their real shape: while you scan, the phone also records the LiDAR
mesh of everything it sees (Home → **Real furniture shapes**, on by default), and the walkthrough
uses it instead of RoomPlan's boxes — sofas, plants, lamps, open shelves. Walk around furniture
you want to look good and look at it from a couple of sides. If scanning ever misbehaves with it
(the camera view freezing, the phone overheating quickly), turn the switch off and scan again.

For good photos, take your time — a slow scan looks much better than a quick one. The app takes
a full-resolution photo whenever the phone is still (at most about one a second), so pause for
a moment on each stretch of wall, then on the floor and ceiling, rather than sweeping
continuously. The scan screen counts the photos and says **Slow down for sharp photos** when
you're moving too fast for them. Get close-ish (1–3 m) to furniture and look at it straight on
from a couple of sides. Surfaces no photo saw are filled in from their surroundings; the scan's
page says how much your photos covered.

The **map** in the top right corner (build 8 on) shows what your photos cover so far: the room
from above, turned the way you're facing (red on the map's left is the wall on your left), with
walls, floor and furniture in green where a photo covers them well, amber where only from the
side or far away, and red where none does yet. Before **Done with this room**, turn toward the red
until it goes green — the floor near where you stand usually needs a slow look down. The numbers
under it are the shares covered well; tap the map to fold it away. If much is still red when you
finish a room, the app asks first.

**A scan from an earlier version?** Builds 1–2 took each room where RoomPlan reported it, and
RoomPlan reports every room relative to where its scan started, so rooms piled up; builds 1–3
didn't use the photos; build 4 blended several photos per spot (soft, sometimes doubled) and
painted furniture as plain boxes; builds before 6 had no "photos off" view; builds before 7
painted people in the photos onto the model; builds before 8 didn't line the photos up with each
other (the phone's tracking drifts a centimeter or two, which doubles edges and smears furniture
colors onto the walls behind). Install the latest build over the old one (your scans stay), open
the scan and tap **Rebuild walkthrough** (*Fix overlapping rooms* / *Add your photos to the
walkthrough* / *Sharpen the photo walkthrough* / *Add the photos-off view* / *Paint people out of
the photos* / *Sharpen edges and line up the photos*), then **Send to Atrium** again. No rescanning: the rebuild uses the
RoomPlan data and photos saved on the phone. The lines under the scan's numbers say how the rooms
were placed, how much the photos cover, how many photos had people painted out, how many were
lined up with each other and whether the furniture was shaped from the LiDAR mesh. Scans made with build 5 or later also get the sharper
full-resolution photos; only scans made with build 7 or later have the LiDAR mesh, so real
furniture shapes need a new scan.

**No LiDAR?** **Create a demo scan** builds a sample two-bedroom apartment on the phone so you
can try pairing and sending on any iPhone.

## What gets sent

| File | What it is |
| --- | --- |
| `scan.glb` | The 3D walkthrough (5–12 MB): walls, floors, ceilings and furniture (in its real shape from the LiDAR mesh, build 7 on) painted with your photos, people painted out (or, if the photos cover too little, a styled model with lights), plus the room/viewpoint/route data. |
| `scan-clean.glb` | Photo scans only (build 6 on): the same rooms as a clean 3D model (1–3 MB), shown when a buyer or you turn the photos off. In **Rooms & viewpoints** you choose whether buyers start with the photos on or off. |
| `package.zip` | Raw data for future reprocessing: RoomPlan's rooms and merged structure, the scan in Atrium's format, the walked path and the photos' positions. The photos and LiDAR meshes themselves stay on the phone (they're already in `scan.glb`). Optional — if the server refuses it (Supabase's free plan limits files to 50 MB) the walkthrough is sent without it. |

Everything also stays on the phone (**Files → On My iPhone → Atrium Capture → Scans**), and
**Share 3D model** exports the `.glb` (e.g. to upload it to a listing by hand).

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Can't reach …* | The phone can't see the server: same Wi‑Fi for a dev server, or use the deployed https address. |
| *This pairing code has expired* | Codes last 24 hours — click **Connect an iPhone** again and rescan. |
| *iPhone uploads need SUPABASE_SERVICE_ROLE_KEY…* | Add the Supabase service-role (or secret) key to the Vercel project's environment variables and redeploy. |
| *Atrium's database isn't set up for iPhone scans yet* | Open `/setup` on your site and run the SQL it shows (safe to run again). |
| *Scanning stopped* (tracking lost / too hot) | Choose **Keep what was scanned** or **Scan this room again**. |
| Rooms overlap in the walkthrough | Open the scan on the phone, tap **Rebuild walkthrough**, then send it again. |
| The camera view freezes or the phone overheats right away | Turn off **Real furniture shapes** on the Home screen and scan again (furniture is then built from RoomPlan's boxes). |

---

## For developers

```
ios/
  project.yml              XcodeGen spec (cd ios && xcodegen regenerates AtriumCapture.xcodeproj)
  AtriumCapture/           SwiftUI app: pairing, RoomPlan capture, processing, upload
  ScanCore/                Swift package (Foundation only — builds and tests on Linux too)
    Sources/AtriumScanCore CaptureScan → .glb walkthrough + scan manifest
    Sources/scanproc       CLI: scanproc process scan.json out.glb --manifest out.json
                                scanproc align room-*.json --out scan.json (RoomPlan JSON → one frame)
  ci/                      simulator-test helpers (mock server, legacy multi-room scan, rebuild check)
```

* `cd ios/ScanCore && swift test` — unit tests (macOS or Linux).
* `swift run scanproc demo-scan apartment.json && swift run scanproc process apartment.json apartment.glb`
  builds the synthetic apartment exactly as the phone would.
* The phone ⇄ server contract, the scan format and the processing rules are in
  [`docs/iphone-capture.md`](../docs/iphone-capture.md).
* CI (`.github/workflows/ios.yml`) runs the ScanCore tests, builds an unsigned Release `.ipa`, and
  in the simulator pairs/sends a demo scan and rebuilds Apple's multi-room RoomPlan sample with
  every room shifted into its own frame; `.github/workflows/ios-testflight.yml` signs and uploads
  to TestFlight when the secrets exist.
