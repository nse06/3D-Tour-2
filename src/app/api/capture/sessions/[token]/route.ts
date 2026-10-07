import { resolveCaptureSession } from "@/lib/capture-api";

/** Pairing check: which listing does this code scan for? (docs/iphone-capture.md §3.2) */
export async function GET(_request: Request, ctx: RouteContext<"/api/capture/sessions/[token]">) {
  const { token } = await ctx.params;
  const resolved = await resolveCaptureSession(token);
  if (resolved instanceof Response) return resolved;
  const { session, property } = resolved.lookup;
  return Response.json({ property, expiresAt: session.expiresAt }, { headers: { "cache-control": "no-store" } });
}
