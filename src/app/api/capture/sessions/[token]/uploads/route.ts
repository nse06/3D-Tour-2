import { apiError, readJson, resolveCaptureSession, serverError } from "@/lib/capture-api";
import { createUploadTarget, UploadError } from "@/lib/storage";

/**
 * Signed upload target for the scan's 3D model ("capture", .glb) or its raw
 * scan package ("package", .zip). The phone PUTs the file straight to
 * storage; `url` may be relative to the server's base URL.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/capture/sessions/[token]/uploads">) {
  const { token } = await ctx.params;
  const resolved = await resolveCaptureSession(token);
  if (resolved instanceof Response) return resolved;
  const { session, property } = resolved.lookup;

  const body = await readJson(request, 64 * 1024);
  const kind = body?.kind;
  if (kind !== "capture" && kind !== "package") return apiError(400, 'kind must be "capture" or "package".');
  try {
    const target = await createUploadTarget(session.userId, property.id, kind, String(body?.filename ?? ""), Number(body?.size ?? 0), { admin: true });
    return Response.json(target, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return e instanceof UploadError ? apiError(e.status, e.message) : serverError(e);
  }
}
