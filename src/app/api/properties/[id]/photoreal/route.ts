import { getCurrentUser } from "@/lib/auth";
import { getRepository } from "@/lib/data/repository";
import { gpuConfigured, jobSummary } from "@/lib/photoreal";

/** The listing's latest photoreal job, polled by the dashboard while it runs. */
export async function GET(_request: Request, ctx: RouteContext<"/api/properties/[id]/photoreal">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in." }, { status: 401 });
  const { id } = await ctx.params;
  const job = await (await getRepository()).latestPhotorealJob(user.id, id);
  return Response.json({ job: job ? jobSummary(job) : null, gpuReady: gpuConfigured() }, { headers: { "cache-control": "no-store" } });
}
