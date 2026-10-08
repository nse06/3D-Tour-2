// Attaching an uploaded capture to a listing. Shared by the dashboard (a
// realtor uploading a .glb) and the iPhone endpoints (Atrium Capture sending
// a scan), so both validate uploads and room data the same way.

import "server-only";
import type { Repository } from "@/lib/data/repository";
import { assetExists, isOwnedAssetUrl } from "@/lib/storage";
import { isScanManifest, manifestToSpace } from "@/lib/tour/scan-manifest";
import { isSpaceError, newId, parseSpace } from "@/lib/tour/space";
import type { CaptureSource } from "@/lib/tour/types";

export interface IngestRequest {
  assetUrl: unknown;
  /** Photo scans: a clean model of the same rooms (the viewer's "photos off" view). */
  cleanAssetUrl?: unknown;
  /** Raw iPhone scan package (.zip), kept for reprocessing. */
  packageUrl?: unknown;
  /** Scan manifest from the file (rooms, floors, waypoints, links), if any. */
  manifest?: unknown;
}

export type IngestResult = { ok: true; rooms: number; floors: number } | { ok: false; status: 400 | 422 | 500; error: string };

/**
 * Validate an uploaded capture and make it the listing's tour. The caller has
 * already established that `userId` owns `propertyId`. `admin` checks storage
 * with the service-role client (the phone has no realtor session).
 */
export async function ingestCapture(
  repo: Repository,
  userId: string,
  propertyId: string,
  source: CaptureSource,
  request: IngestRequest,
  options: { admin?: boolean } = {},
): Promise<IngestResult> {
  const { assetUrl, cleanAssetUrl = null, packageUrl = null, manifest = null } = request;
  if (typeof assetUrl !== "string" || !isOwnedAssetUrl(assetUrl, userId, propertyId, "capture")) {
    return { ok: false, status: 400, error: "Unknown upload." };
  }
  if (cleanAssetUrl !== null && (typeof cleanAssetUrl !== "string" || !isOwnedAssetUrl(cleanAssetUrl, userId, propertyId, "capture"))) {
    return { ok: false, status: 400, error: "Unknown clean model upload." };
  }
  if (packageUrl !== null && (typeof packageUrl !== "string" || !isOwnedAssetUrl(packageUrl, userId, propertyId, "package"))) {
    return { ok: false, status: 400, error: "Unknown scan package." };
  }
  if (!(await assetExists(assetUrl, options))) {
    return { ok: false, status: 400, error: "The 3D model didn't finish uploading. Please try again." };
  }
  // The clean model is optional: if it didn't arrive, the tour goes up with photos only.
  const clean = cleanAssetUrl !== null && (await assetExists(cleanAssetUrl as string, options)) ? (cleanAssetUrl as string) : null;

  let space = null;
  let appearance: "studio" | "captured" = "studio";
  if (manifest !== null) {
    if (!isScanManifest(manifest)) return { ok: false, status: 422, error: "The scan's room data isn't in a format Atrium understands." };
    try {
      space = parseSpace(manifestToSpace(manifest, () => newId()));
    } catch (e) {
      if (isSpaceError(e)) return { ok: false, status: 422, error: `The scan's room data is invalid: ${(e as Error).message}` };
      throw e;
    }
    // manifestToSpace skips rooms on unknown floors; a scan must not silently lose rooms.
    if (space.rooms.length < manifest.rooms.length) return { ok: false, status: 422, error: "The scan's room data is invalid: a room is on an unknown floor." };
    if (source === "ios_scan" && space.rooms.length === 0)
      return { ok: false, status: 422, error: "The scan has no rooms. Scan at least one room and send it again." };
    if (manifest.appearance === "captured") appearance = "captured";
  } else if (source === "ios_scan") {
    return { ok: false, status: 422, error: "The scan is missing its room data." };
  }

  try {
    await repo.attachCapture(userId, propertyId, {
      assetUrl,
      cleanAssetUrl: clean,
      assetFormat: assetUrl.toLowerCase().endsWith(".gltf") ? "gltf" : "glb",
      source,
      scanPackageUrl: packageUrl as string | null,
      space,
      appearance,
    });
  } catch (e) {
    return { ok: false, status: 500, error: (e as Error).message };
  }
  return { ok: true, rooms: space?.rooms.length ?? 0, floors: space?.floors.length ?? 0 };
}
