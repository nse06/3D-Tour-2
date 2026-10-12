import { getCurrentUser } from "@/lib/auth";
import { getRepository } from "@/lib/data/repository";
import { remasterSummary } from "@/lib/remaster";

/** The listing's latest remaster job, polled by the dashboard while it runs. */
export async function GET(_request: Request, ctx: RouteContext<"/api/properties/[id]/remaster">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in." }, { status: 401 });
  const { id } = await ctx.params;
  const job = await (await getRepository()).latestRemasterJob(user.id, id);
  return Response.json({ job: job ? remasterSummary(job) : null }, { headers: { "cache-control": "no-store" } });
}
