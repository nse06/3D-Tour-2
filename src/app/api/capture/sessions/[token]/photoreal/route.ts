import { apiError, readJson, resolveCaptureSession, serverError } from "@/lib/capture-api";
import { checkPhotorealFiles, inputUploadLinks } from "@/lib/photoreal";

/**
 * Starts a photoreal walkthrough of the listing's scan (docs/photoreal.md): the phone lists the
 * files it will upload (cameras.json, seeds.ply, frames/*.jpg, masks/*.png with their sizes) and
 * gets a job and a signed upload link per file. Body: { files: [{ name, size }], assetUrl? }, where
 * assetUrl is the model the phone sent for this scan: if the listing shows another scan's model
 * now, the photos wouldn't line up with it, so the phone is asked to send this scan again first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/capture/sessions/[token]/photoreal">) {
  const { token } = await ctx.params;
  const resolved = await resolveCaptureSession(token);
  if (resolved instanceof Response) return resolved;
  const { repo, lookup } = resolved;
  const { session, property } = lookup;

  const body = await readJson(request, 1024 * 1024);
  const checked = checkPhotorealFiles(body?.files);
  if ("error" in checked) return apiError(400, checked.error);
  try {
    if (typeof body?.assetUrl === "string") {
      const current = (await repo.getProperty(session.userId, property.id))?.tour?.assetUrl;
      if (current && current !== body.assetUrl) {
        return apiError(409, "The listing shows a different scan now. Send this scan to Atrium again, then make it photoreal.");
      }
    }
    const job = await repo.createPhotorealJob(session.userId, property.id, { files: checked.files.length, bytes: checked.bytes });
    if (!job) return apiError(409, "Send the scan to Atrium first, then make it photoreal.");
    const uploads = await inputUploadLinks(job, checked.files);
    return Response.json({ jobId: job.id, uploads }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return serverError(e);
  }
}
