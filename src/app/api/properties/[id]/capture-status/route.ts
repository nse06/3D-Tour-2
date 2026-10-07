import { getCurrentUser } from "@/lib/auth";
import { getRepository } from "@/lib/data/repository";

/** Polled by the "Scan with iPhone" panel to notice when the phone's scan has arrived. */
export async function GET(_request: Request, ctx: RouteContext<"/api/properties/[id]/capture-status">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in." }, { status: 401 });
  const { id } = await ctx.params;
  const bundle = await (await getRepository()).getProperty(user.id, id);
  if (!bundle) return Response.json({ error: "Property not found." }, { status: 404 });
  const { tour, space } = bundle;
  return Response.json(
    {
      tour: tour ? { id: tour.id, source: tour.source, createdAt: tour.createdAt } : null,
      rooms: space?.rooms.length ?? 0,
      floors: space?.floors.length ?? 0,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
