import Link from "next/link";
import { notFound } from "next/navigation";
import TourViewer, { type SplatVersion } from "@/components/tour/TourViewer";
import { requireUser } from "@/lib/auth";
import { bundleToTourData, getRepository } from "@/lib/data/repository";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preview tour" };

export default async function PreviewPage(props: PageProps<"/dashboard/properties/[id]/preview">) {
  const { id } = await props.params;
  const user = await requireUser();
  const repo = await getRepository();
  const bundle = await repo.getProperty(user.id, id);
  if (!bundle) notFound();
  const data = bundleToTourData(bundle);
  if (!data) notFound();
  const live = bundle.property.published && !!bundle.tour?.published;
  // Both versions of the photoreal walkthrough, to compare (docs/photoreal.md §3.1).
  const job = data.splatUrl ? await repo.latestPhotorealJob(user.id, id).catch(() => null) : null;
  const ai = job?.variants?.ai;
  const versions: SplatVersion[] | undefined =
    job?.splatUrl && ai?.status === "done" && ai.splatUrl && [job.splatUrl, ai.splatUrl].includes(data.splatUrl!)
      ? [
          { key: "faithful", label: "Faithful", url: job.splatUrl },
          { key: "ai", label: "AI-enhanced", url: ai.splatUrl },
        ]
      : undefined;
  return (
    <TourViewer
      data={data}
      splatVersions={versions}
      compareRemaster={!!data.remasterUrl}
      shareUrl={live ? `/tour/${bundle.property.slug}` : null}
      banner={
        <div className="glass-strong flex items-center gap-3 rounded-full py-1.5 pl-4 pr-1.5 text-[13px] text-white">
          <span className={`size-2 rounded-full ${live ? "bg-emerald-400" : "bg-amber-400"}`} />
          {live ? "Preview · this tour is live" : "Preview · only you can see this"}
          <Link href={`/dashboard/properties/${id}`} className="rounded-full bg-white px-3 py-1 font-medium text-neutral-900 hover:bg-white/90">
            {live ? "Back to listing" : "Publish"}
          </Link>
        </div>
      }
    />
  );
}
