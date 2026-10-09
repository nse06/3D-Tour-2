import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { apiError, resolveCaptureSession, serverError } from "@/lib/capture-api";
import { serverBaseUrl } from "@/lib/capture-sessions";
import type { Repository } from "@/lib/data/repository";
import type { CaptureSessionLookup } from "@/lib/data/types";
import { dispatchJob, inputNames, jobSummary } from "@/lib/photoreal";

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

/** The phone uploaded every file: check they arrived and hand the job to the GPU. */
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
    job = (await repo.updatePhotorealJob(job.id, { status: "queued", stage: null, progress: 0, message: null })) ?? job;
    job = await dispatchJob(repo, job, serverBaseUrl(await headers()).url);
    revalidatePath(`/dashboard/properties/${lookup.property.id}`);
    return Response.json(jobSummary(job), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return serverError(e);
  }
}
