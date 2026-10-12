import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { apiError, readJson, serverError } from "@/lib/capture-api";
import { serverBaseUrl } from "@/lib/capture-sessions";
import { getAdminRepository } from "@/lib/data/repository";
import type { PhotorealVariant } from "@/lib/data/types";
import { checkSpots, isWorkerRequest, jobSummary, pruneListingPhotos, workerSecret } from "@/lib/photoreal";
import { assetExists, createUploadTarget, isOwnedAssetUrl, UploadError } from "@/lib/storage";

/**
 * The GPU worker reports on a photoreal job (worker/photoreal/atrium_photoreal/job.py), with the
 * shared secret (Authorization: Bearer PHOTOREAL_WORKER_SECRET). Events:
 *   { event: "progress", stage, progress (0–1), message }
 *   { event: "upload", bytes }       → { url, method, headers, assetUrl } for the splats (.spz)
 *   { event: "done", assetUrl, stats, spots, pending? }   spots: where the photos were taken, [[x, y, z, yaw, pitch], …];
 *                                    pending: ["ai"] when the AI-enhanced version follows
 *   { event: "failed", message }
 * and after "done", for the AI-enhanced version (docs/photoreal.md §3.1):
 *   { event: "progress", variant: "ai", progress, message }
 *   { event: "upload", variant: "ai", bytes } → where its splats go
 *   { event: "variant", name: "ai", status: "done", assetUrl, stats } or { …, status: "failed", message }
 */
export async function POST(request: Request, ctx: RouteContext<"/api/photoreal/jobs/[id]">) {
  if (!workerSecret()) return apiError(503, "PHOTOREAL_WORKER_SECRET isn't set on this server.");
  if (!isWorkerRequest(request)) return apiError(401, "Unauthorized.");
  const { id } = await ctx.params;
  const body = await readJson(request, 256 * 1024);
  if (!body || typeof body.event !== "string") return apiError(400, "Expected a JSON body with an event.");
  try {
    const repo = await getAdminRepository();
    const job = await repo.getPhotorealJob(id);
    if (!job) return apiError(404, "No such photoreal job.");
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);
    const statsOf = (value: unknown) => (value && typeof value === "object" && JSON.stringify(value).length < 8192 ? (value as Record<string, unknown>) : null);

    // The AI-enhanced version, after the faithful one is done.
    if (body.variant !== undefined || body.event === "variant") {
      const ai = job.variants?.ai;
      if ((body.variant ?? body.name) !== "ai") return apiError(400, "Unknown version.");
      if (job.status !== "done" || ai?.status !== "running") return apiError(409, "No AI-enhanced version is on its way for this job.");
      const save = async (next: PhotorealVariant) => {
        const updated = await repo.updatePhotorealJob(job.id, { variants: { ...job.variants, ai: next } });
        revalidatePath(`/dashboard/properties/${job.propertyId}`);
        return Response.json(updated ? jobSummary(updated) : { ok: true });
      };
      switch (body.event) {
        case "progress":
          return save({ ...ai, progress: Math.max(0, Math.min(1, Number(body.progress) || 0)), message: text(body.message, 200) });
        case "upload": {
          const target = await createUploadTarget(job.userId, job.propertyId, "splat", "splats-ai.spz", Number(body.bytes), { admin: true });
          const base = serverBaseUrl(await headers()).url;
          return Response.json({ ...target, url: target.url.startsWith("/") ? `${base}${target.url}` : target.url }, { headers: { "cache-control": "no-store" } });
        }
        case "variant":
          if (body.status === "failed") return save({ ...ai, status: "failed", message: text(body.message, 500) ?? "The AI-enhanced version couldn't be made." });
          if (body.status !== "done") return apiError(400, "status must be done or failed.");
          if (!isOwnedAssetUrl(body.assetUrl, job.userId, job.propertyId, "splat") || !(await assetExists(body.assetUrl as string, { admin: true }))) {
            return apiError(400, "assetUrl must be the uploaded splats.");
          }
          return save({ status: "done", progress: 1, splatUrl: body.assetUrl as string, stats: statsOf(body.stats), message: null });
        default:
          return apiError(400, `Unknown event: ${String(body.event).slice(0, 40)}`);
      }
    }

    if (job.status === "done" || job.status === "failed") return apiError(409, `The job is already ${job.status}.`);
    switch (body.event) {
      case "progress": {
        const progress = Math.max(0, Math.min(1, Number(body.progress) || 0));
        const updated = await repo.updatePhotorealJob(job.id, {
          status: "running",
          stage: text(body.stage, 40),
          progress,
          message: text(body.message, 200),
          ...(job.startedAt ? {} : { startedAt: new Date().toISOString() }),
        });
        return Response.json(updated ? jobSummary(updated) : { ok: true });
      }
      case "upload": {
        const target = await createUploadTarget(job.userId, job.propertyId, "splat", "splats.spz", Number(body.bytes), { admin: true });
        // Local storage hands out links relative to this site.
        const base = serverBaseUrl(await headers()).url;
        const absolute = (url: string) => (url.startsWith("/") ? `${base}${url}` : url);
        return Response.json({ ...target, url: absolute(target.url), assetUrl: target.assetUrl }, { headers: { "cache-control": "no-store" } });
      }
      case "done": {
        const assetUrl = body.assetUrl;
        if (!isOwnedAssetUrl(assetUrl, job.userId, job.propertyId, "splat") || !(await assetExists(assetUrl as string, { admin: true }))) {
          return apiError(400, "assetUrl must be the uploaded splats.");
        }
        const stats = statsOf(body.stats);
        // A newer job for the same scan that finished first (trained again, or sent again from the
        // phone) keeps its splats.
        const newer = (await repo.listPhotorealJobs(job.userId, job.propertyId)).some(
          (j) => j.id !== job.id && j.tourId === job.tourId && j.status === "done" && j.createdAt > job.createdAt,
        );
        const attached = !newer && (await repo.attachSplats(job, assetUrl as string, checkSpots(body.spots)));
        const updated = await repo.updatePhotorealJob(job.id, {
          status: "done",
          stage: null,
          progress: 1,
          message: attached
            ? null
            : newer
              ? "A newer photoreal walkthrough of this scan was ready first, so buyers see that one."
              : "The scan was sent again since; send the new one through photoreal to see it.",
          splatUrl: assetUrl as string,
          stats,
          finishedAt: new Date().toISOString(),
        });
        if (Array.isArray(body.pending) && body.pending.includes("ai")) {
          // The AI-enhanced version follows. (Its own write: a database without the column still
          // takes the faithful version, and the AI one's reports are then turned away.)
          await repo
            .updatePhotorealJob(job.id, { variants: { ai: { status: "running", progress: 0, splatUrl: null, stats: null, message: null } } })
            .catch((e) => console.error("photoreal: could not note the AI-enhanced version:", (e as Error).message));
        }
        // The photos stay in storage, so the listing can be trained again without a rescan (older
        // uploads' photos this job held on to go now).
        await pruneListingPhotos(repo, job.userId, job.propertyId).catch((e) => console.error("photoreal: could not delete older photos:", (e as Error).message));
        revalidatePath(`/dashboard/properties/${job.propertyId}`);
        return Response.json(updated ? jobSummary(updated) : { ok: true });
      }
      case "failed": {
        const updated = await repo.updatePhotorealJob(job.id, {
          status: "failed",
          stage: null,
          message: text(body.message, 500) ?? "The GPU couldn't finish the job.",
          finishedAt: new Date().toISOString(),
        });
        await pruneListingPhotos(repo, job.userId, job.propertyId).catch((e) => console.error("photoreal: could not delete older photos:", (e as Error).message));
        revalidatePath(`/dashboard/properties/${job.propertyId}`);
        return Response.json(updated ? jobSummary(updated) : { ok: true });
      }
      default:
        return apiError(400, `Unknown event: ${String(body.event).slice(0, 40)}`);
    }
  } catch (e) {
    if (e instanceof UploadError) return apiError(e.status, e.message);
    return serverError(e);
  }
}
