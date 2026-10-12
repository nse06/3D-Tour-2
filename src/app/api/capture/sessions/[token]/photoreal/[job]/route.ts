import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { claim, payerFor, photorealAccess } from "@/lib/billing/access";
import { PHOTOREAL_UNPAID, PHOTOS_FOR_REMASTER, REMASTER_UNPAID } from "@/lib/billing/plans";
import { apiError, resolveCaptureSession, serverError } from "@/lib/capture-api";
import { serverBaseUrl } from "@/lib/capture-sessions";
import type { Repository } from "@/lib/data/repository";
import type { CaptureSessionLookup } from "@/lib/data/types";
import { dispatchJob, inputNames, jobSummary, pruneListingPhotos } from "@/lib/photoreal";
import { photosForRemaster, queueRemaster, remasterConfigured } from "@/lib/remaster";

type Context = RouteContext<"/api/capture/sessions/[token]/photoreal/[job]">;

async function sessionJob(ctx: Context): Promise<{ repo: Repository; lookup: CaptureSessionLookup; jobId: string } | Response> {
  const { token, job } = await ctx.params;
  const resolved = await resolveCaptureSession(token);
  if (resolved instanceof Response) return resolved;
  return { ...resolved, jobId: job };
}

/** How the job is doing (the phone shows it after uploading). */
export async function GET(_request: Request, ctx: Context) {
  const resolved = await sessionJob(ctx);
  if (resolved instanceof Response) return resolved;
  const { repo, lookup, jobId } = resolved;
  try {
    const job = await repo.getPhotorealJob(jobId);
    if (!job || job.userId !== lookup.session.userId || job.propertyId !== lookup.property.id) return apiError(404, "No such photoreal job.");
    return Response.json(jobSummary(job), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return serverError(e);
  }
}

/**
 * The phone uploaded every file: check they arrived and start the remastered model from them
 * (docs/remaster.md). The photoreal job they came with waits until the realtor starts photoreal in
 * the dashboard; without a remaster GPU, photoreal starts as before. When it has to be paid for
 * first, it waits; paying on the website starts it (the phone never shows prices: payment happens
 * on the website). The listing's older photos go: these replace them.
 */
export async function POST(_request: Request, ctx: Context) {
  const resolved = await sessionJob(ctx);
  if (resolved instanceof Response) return resolved;
  const { repo, lookup, jobId } = resolved;
  try {
    let job = await repo.getPhotorealJob(jobId);
    if (!job || job.userId !== lookup.session.userId || job.propertyId !== lookup.property.id) return apiError(404, "No such photoreal job.");
    // Sent twice (a retry after a lost answer): say where it stands.
    if (job.status !== "uploading") return Response.json(jobSummary(job), { headers: { "cache-control": "no-store" } });
    const names = new Set(await inputNames(job));
    if (!names.has("cameras.json") || !names.has("seeds.ply") || names.size < job.files) {
      return apiError(400, `Only ${names.size} of ${job.files} files arrived. Try sending again.`);
    }
    const access = await photorealAccess(await payerFor(lookup.session.userId), lookup.property.id);
    if (access.allowed) await claim(access);
    const remaster = remasterConfigured();
    const message = remaster ? (access.allowed ? PHOTOS_FOR_REMASTER : REMASTER_UNPAID) : access.allowed ? null : PHOTOREAL_UNPAID;
    job = (await repo.updatePhotorealJob(job.id, { status: "queued", stage: null, progress: 0, message })) ?? job;
    const baseUrl = serverBaseUrl(await headers()).url;
    if (access.allowed && !remaster) job = await dispatchJob(repo, job, baseUrl);
    if (access.allowed && remaster) {
      // The photos are in either way: a GPU that doesn't take it leaves the remaster waiting in the dashboard.
      try {
        const tour = (await repo.getProperty(job.userId, job.propertyId))?.tour;
        const upload = tour ? await photosForRemaster(repo, job.userId, job.propertyId, tour) : null;
        if (tour && upload) await queueRemaster(repo, job.userId, job.propertyId, tour, upload, baseUrl);
      } catch (e) {
        console.error("remaster: could not start from the phone's photos:", (e as Error).message);
      }
    }
    await pruneListingPhotos(repo, job.userId, job.propertyId).catch((e) => console.error("photoreal: could not delete older photos:", (e as Error).message));
    revalidatePath(`/dashboard/properties/${lookup.property.id}`);
    return Response.json(jobSummary(job), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return serverError(e);
  }
}
