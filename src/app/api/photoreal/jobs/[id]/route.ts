import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { apiError, readJson, serverError } from "@/lib/capture-api";
import { serverBaseUrl } from "@/lib/capture-sessions";
import { getAdminRepository } from "@/lib/data/repository";
import { checkSpots, deleteInputs, isWorkerRequest, jobSummary, workerSecret } from "@/lib/photoreal";
import { assetExists, createUploadTarget, isOwnedAssetUrl, UploadError } from "@/lib/storage";

/**
 * The GPU worker reports on a photoreal job (worker/photoreal/atrium_photoreal/job.py), with the
 * shared secret (Authorization: Bearer PHOTOREAL_WORKER_SECRET). Events:
 *   { event: "progress", stage, progress (0–1), message }
 *   { event: "upload", bytes }       → { url, method, headers, assetUrl } for the splats (.spz)
 *   { event: "done", assetUrl, stats, spots }   spots: where the photos were taken, [[x, y, z, yaw, pitch], …]
 *   { event: "failed", message }
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
    if (job.status === "done" || job.status === "failed") return apiError(409, `The job is already ${job.status}.`);
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

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
        const stats = body.stats && typeof body.stats === "object" && JSON.stringify(body.stats).length < 8192 ? (body.stats as Record<string, unknown>) : null;
        const attached = await repo.attachSplats(job, assetUrl as string, checkSpots(body.spots));
        const updated = await repo.updatePhotorealJob(job.id, {
          status: "done",
          stage: null,
          progress: 1,
          message: attached ? null : "The scan was sent again since; send the new one through photoreal to see it.",
          splatUrl: assetUrl as string,
          stats,
          finishedAt: new Date().toISOString(),
        });
        // The photos stay on the phone; the server keeps only the splats.
        await deleteInputs(job).catch((e) => console.error("photoreal: could not delete the inputs:", (e as Error).message));
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
