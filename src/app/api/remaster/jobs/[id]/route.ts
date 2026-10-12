import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { apiError, readJson, serverError } from "@/lib/capture-api";
import { serverBaseUrl } from "@/lib/capture-sessions";
import { getAdminRepository } from "@/lib/data/repository";
import { isWorkerRequest, pruneListingPhotos, workerSecret } from "@/lib/photoreal";
import { remasterSummary } from "@/lib/remaster";
import { assetExists, createUploadTarget, isOwnedAssetUrl, UploadError } from "@/lib/storage";

/**
 * The remaster worker reports on a job (worker/remaster/atrium_remaster/job.py), with the shared
 * secret (Authorization: Bearer PHOTOREAL_WORKER_SECRET). Events:
 *   { event: "progress", stage, progress (0–1), message }
 *   { event: "upload", files: [{ name: "model.glb", bytes }] } → { targets: [{ name, url, method, headers, assetUrl }] }
 *   { event: "done", modelUrl, stats }
 *   { event: "failed", message }
 */
export async function POST(request: Request, ctx: RouteContext<"/api/remaster/jobs/[id]">) {
  if (!workerSecret()) return apiError(503, "PHOTOREAL_WORKER_SECRET isn't set on this server.");
  if (!isWorkerRequest(request)) return apiError(401, "Unauthorized.");
  const { id } = await ctx.params;
  const body = await readJson(request, 256 * 1024);
  if (!body || typeof body.event !== "string") return apiError(400, "Expected a JSON body with an event.");
  try {
    const repo = await getAdminRepository();
    const job = await repo.getRemasterJob(id);
    if (!job) return apiError(404, "No such remaster job.");
    if (job.status === "done" || job.status === "failed") return apiError(409, `The job is already ${job.status}.`);
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);
    const statsOf = (value: unknown) => (value && typeof value === "object" && JSON.stringify(value).length < 8192 ? (value as Record<string, unknown>) : null);
    const finish = async () => {
      // The photos a finished job held on to may go now, if a newer upload replaced them.
      await pruneListingPhotos(repo, job.userId, job.propertyId).catch((e) => console.error("remaster: could not delete older photos:", (e as Error).message));
      revalidatePath(`/dashboard/properties/${job.propertyId}`);
    };

    switch (body.event) {
      case "progress": {
        const updated = await repo.updateRemasterJob(job.id, {
          status: "running",
          stage: text(body.stage, 40),
          progress: Math.max(0, Math.min(1, Number(body.progress) || 0)),
          message: text(body.message, 200),
          ...(job.startedAt ? {} : { startedAt: new Date().toISOString() }),
        });
        return Response.json(updated ? remasterSummary(updated) : { ok: true });
      }
      case "upload": {
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length || files.length > 1) return apiError(400, "Expected the remastered model (model.glb).");
        const base = serverBaseUrl(await headers()).url;
        const targets = [];
        for (const file of files) {
          if (file?.name !== "model.glb") return apiError(400, `Unexpected file: ${String(file?.name).slice(0, 60)}`);
          const target = await createUploadTarget(job.userId, job.propertyId, "remaster", "model.glb", Number(file.bytes), { admin: true });
          // Local storage hands out links relative to this site.
          targets.push({ name: file.name, ...target, url: target.url.startsWith("/") ? `${base}${target.url}` : target.url });
        }
        return Response.json({ targets }, { headers: { "cache-control": "no-store" } });
      }
      case "done": {
        const modelUrl = body.modelUrl;
        if (!isOwnedAssetUrl(modelUrl, job.userId, job.propertyId, "remaster") || !(await assetExists(modelUrl as string, { admin: true }))) {
          return apiError(400, "modelUrl must be the uploaded model.");
        }
        // A newer remaster of the same scan that finished first keeps its model.
        const newer = (await repo.listRemasterJobs(job.userId, job.propertyId)).some(
          (j) => j.id !== job.id && j.tourId === job.tourId && j.status === "done" && j.createdAt > job.createdAt,
        );
        const attached = !newer && (await repo.attachRemaster(job, modelUrl as string));
        const updated = await repo.updateRemasterJob(job.id, {
          status: "done",
          stage: null,
          progress: 1,
          message: attached
            ? null
            : newer
              ? "A newer remaster of this scan was ready first, so the listing keeps that one."
              : "The scan was sent again since; remaster the new one to see it.",
          modelUrl: modelUrl as string,
          stats: statsOf(body.stats),
          finishedAt: new Date().toISOString(),
        });
        await finish();
        revalidatePath(`/dashboard/properties/${job.propertyId}/preview`);
        return Response.json(updated ? remasterSummary(updated) : { ok: true });
      }
      case "failed": {
        const updated = await repo.updateRemasterJob(job.id, {
          status: "failed",
          stage: null,
          message: text(body.message, 500) ?? "The GPU couldn't finish the remaster.",
          finishedAt: new Date().toISOString(),
        });
        await finish();
        return Response.json(updated ? remasterSummary(updated) : { ok: true });
      }
      default:
        return apiError(400, `Unknown event: ${String(body.event).slice(0, 40)}`);
    }
  } catch (e) {
    if (e instanceof UploadError) return apiError(e.status, e.message);
    return serverError(e);
  }
}
