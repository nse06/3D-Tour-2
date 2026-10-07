import { getCurrentUser } from "@/lib/auth";
import { getRepository } from "@/lib/data/repository";
import { createUploadTarget, type UploadKind } from "@/lib/storage";

/** Issue a signed upload target for a capture (.glb/.gltf) or a cover photo. */
export async function POST(request: Request, ctx: RouteContext<"/api/properties/[id]/uploads">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in." }, { status: 401 });
  const { id } = await ctx.params;
  const repo = await getRepository();
  if (!(await repo.getProperty(user.id, id))) return Response.json({ error: "Property not found." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { kind?: UploadKind; filename?: string; size?: number } | null;
  const kind = body?.kind === "cover" ? "cover" : "capture";
  try {
    const target = await createUploadTarget(user.id, id, kind, String(body?.filename ?? ""), Number(body?.size ?? 0));
    return Response.json(target);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
