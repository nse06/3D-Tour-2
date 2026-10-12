// Remastered models (docs/remaster.md). A cloud GPU (worker/remaster, REMASTER_GPU_URL) rebuilds a
// photo scan's painted model from the photos kept on the server — skins trained on every photo,
// unseen spots filled in — and reports back to /api/remaster/jobs/<id> with the shared
// PHOTOREAL_WORKER_SECRET until the new model (.glb) is stored next to the tour's other files. Its own
// jobs and its own look, separate from the photoreal splats: it only borrows the photos a photoreal
// upload left (lib/photoreal.ts), so either can be switched off without the other.

import "server-only";
import type { Repository } from "@/lib/data/repository";
import type { PhotorealJob, RemasterJob, Tour } from "@/lib/data/types";
import { inputDownloadLinks, inputNames, photosJobId, photosOnServer, workerSecret } from "@/lib/photoreal";

/** The remaster worker's start endpoint (its Modal deployment's URL), or null. */
export function remasterGpuUrl(): string | null {
  const url = process.env.REMASTER_GPU_URL?.trim();
  return url && /^https?:\/\//.test(url) ? url : null;
}

export function remasterConfigured(): boolean {
  return !!remasterGpuUrl() && !!workerSecret();
}

export const WAITING_FOR_REMASTER_GPU = "Waiting for the remaster GPU to be connected (REMASTER_GPU_URL and PHOTOREAL_WORKER_SECRET on the server).";

export const NO_PHOTOS = "Remastering works from the scan's photos on the server. In Atrium Capture, make the scan photoreal once: that sends them.";

/** Whether a job is still working on (or waiting for) its photos. */
export function remasterBusy(job: Pick<RemasterJob, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * The photoreal upload whose photos a remaster of the listing's current scan can use: the one the
 * latest photoreal job for that scan trained from, if its photos are still on the server.
 */
export async function photosForRemaster(repo: Repository, userId: string, propertyId: string, tour: Tour): Promise<PhotorealJob | null> {
  const latest = await repo.latestPhotorealJob(userId, propertyId);
  if (!latest || latest.tourId !== tour.id || latest.status === "uploading") return null;
  const upload = latest.inputsJobId ? await repo.getPhotorealJob(photosJobId(latest)) : latest;
  if (!upload || upload.inputsDeletedAt) return null;
  return (await photosOnServer(upload)) ? upload : null;
}

/** Options the site asks the worker for (the worker's defaults otherwise). */
function remasterOptions(): Record<string, unknown> {
  const raw = process.env.REMASTER_OPTIONS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.error("remaster: REMASTER_OPTIONS isn't JSON; using the worker's defaults");
    return {};
  }
}

/**
 * Hands a queued job to the GPU: the kept photos (signed links), the painted model it rebuilds, and
 * where to report. Without a GPU the job waits in "queued"; if the GPU doesn't take it, it waits there
 * with the reason.
 */
export async function dispatchRemaster(repo: Repository, job: RemasterJob, upload: PhotorealJob, tour: Tour, baseUrl: string): Promise<RemasterJob> {
  const url = remasterGpuUrl();
  const secret = workerSecret();
  if (!url || !secret) return (await repo.updateRemasterJob(job.id, { status: "queued", stage: null, message: WAITING_FOR_REMASTER_GPU })) ?? job;
  const names = await inputNames(upload);
  const files = await inputDownloadLinks(upload, names, baseUrl);
  const model = tour.assetUrl.startsWith("/") ? `${baseUrl}${tour.assetUrl}` : tour.assetUrl;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jobId: job.id, callback: `${baseUrl}/api/remaster/jobs/${job.id}`, files, model: { url: model }, options: remasterOptions() }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 200);
      return (
        (await repo.updateRemasterJob(job.id, { status: "queued", message: `The GPU didn't take the job (HTTP ${response.status}) ${text}`.trim() })) ?? job
      );
    }
  } catch (e) {
    return (await repo.updateRemasterJob(job.id, { status: "queued", message: `Couldn't reach the GPU: ${(e as Error).message}` })) ?? job;
  }
  return (
    (await repo.updateRemasterJob(job.id, {
      status: "running",
      stage: "starting",
      progress: 0,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    })) ?? job
  );
}

/** What the dashboard shows of a job. */
export function remasterSummary(job: RemasterJob) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    modelUrl: job.modelUrl,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stats: job.stats,
  };
}

export type RemasterSummary = ReturnType<typeof remasterSummary>;
