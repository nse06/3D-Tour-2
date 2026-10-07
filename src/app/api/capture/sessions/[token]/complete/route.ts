import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { apiError, readJson, resolveCaptureSession, serverError } from "@/lib/capture-api";
import { serverBaseUrl } from "@/lib/capture-sessions";
import { ingestCapture } from "@/lib/ingest";

/**
 * The phone finished uploading: make the scan the listing's walkthrough.
 * Body: { assetUrl, packageUrl | null, manifest } (docs/iphone-capture.md §3.2).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/capture/sessions/[token]/complete">) {
  const { token } = await ctx.params;
  const resolved = await resolveCaptureSession(token);
  if (resolved instanceof Response) return resolved;
  const { repo, lookup } = resolved;
  const { session, property } = lookup;

  const body = await readJson(request);
  if (!body) return apiError(400, "Expected a JSON body with assetUrl, packageUrl and manifest.");
  try {
    const result = await ingestCapture(
      repo,
      session.userId,
      property.id,
      "ios_scan",
      { assetUrl: body.assetUrl, packageUrl: body.packageUrl ?? null, manifest: body.manifest ?? null },
      { admin: true },
    );
    if (!result.ok) return apiError(result.status, result.error);
    await repo.completeCaptureSession(session.userId, session.id);

    revalidatePath(`/dashboard/properties/${property.id}`);
    revalidatePath("/dashboard");
    const base = serverBaseUrl(await headers()).url;
    return Response.json(
      {
        ok: true,
        rooms: result.rooms,
        floors: result.floors,
        propertyUrl: `${base}/dashboard/properties/${property.id}`,
        previewUrl: `${base}/dashboard/properties/${property.id}/preview`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return serverError(e);
  }
}
