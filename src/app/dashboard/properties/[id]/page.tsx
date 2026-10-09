import { ArrowLeft, Box, Eye, Layers, MousePointerClick, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CaptureUploader } from "@/components/dashboard/CaptureUploader";
import { PhoneCapturePanel } from "@/components/dashboard/PhoneCapturePanel";
import { PhotorealPanel } from "@/components/dashboard/PhotorealPanel";
import { AttachDemoButton, DeletePropertyButton, PublishPanel } from "@/components/dashboard/PropertyActions";
import { PropertyForm } from "@/components/dashboard/PropertyForm";
import { ButtonLink, Card, StatusPill } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getRepository } from "@/lib/data/repository";
import { cityLine, formatPrice } from "@/lib/format";
import { gpuConfigured, jobSummary } from "@/lib/photoreal";
import { sortedFloors } from "@/lib/tour/navigation";
import { updatePropertyAction } from "../../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/dashboard/properties/[id]">) {
  const { id } = await props.params;
  const user = await requireUser();
  const bundle = await (await getRepository()).getProperty(user.id, id);
  return { title: bundle?.property.addressLine ?? "Listing" };
}

const SOURCE_LABEL = { demo: "Sample capture", upload: "Uploaded model", ios_scan: "iPhone LiDAR scan" } as const;

export default async function PropertyPage(props: PageProps<"/dashboard/properties/[id]">) {
  const { id } = await props.params;
  const { scan } = await props.searchParams;
  const user = await requireUser();
  const repo = await getRepository();
  const bundle = await repo.getProperty(user.id, id);
  if (!bundle) notFound();
  const { property: p, tour, space } = bundle;
  // The photoreal panel is a side show: a database that can't answer yet mustn't break the page.
  const photorealJob = await repo.latestPhotorealJob(user.id, id).catch((e) => {
    console.error("photoreal job lookup:", (e as Error).message);
    return null;
  });
  const live = p.published && !!tour?.published;
  const floors = space ? sortedFloors(space) : [];
  const roomCount = space?.rooms.length ?? 0;

  return (
    <div className="rise">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-ink">
        <ArrowLeft className="size-4" /> Listings
      </Link>
      <div className="mt-4 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <StatusPill published={live} />
            <span className="text-sm text-neutral-500">{formatPrice(p.price)}</span>
          </div>
          <h1 className="font-display mt-3 text-5xl leading-[1.05]">{p.addressLine}</h1>
          <p className="mt-1 text-neutral-500">{cityLine(p)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tour && (
            <ButtonLink href={`/dashboard/properties/${p.id}/preview`} variant="secondary" size="lg">
              <Eye className="size-4" /> Preview tour
            </ButtonLink>
          )}
        </div>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="relative aspect-[16/8] bg-linen">
              {p.coverImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.coverImageUrl} alt="" className="size-full object-cover" />
              ) : (
                <div className="grid size-full place-items-center">
                  <Box className="size-12 text-stone/50" strokeWidth={1} />
                </div>
              )}
              {tour && (
                <Link
                  href={`/dashboard/properties/${p.id}/preview`}
                  className="group absolute inset-0 grid place-items-center bg-black/0 transition hover:bg-black/25"
                  aria-label="Preview the 3D tour"
                >
                  <span className="flex items-center gap-2 rounded-full bg-white/95 px-5 py-2.5 text-sm font-medium text-ink opacity-0 shadow-lg transition group-hover:opacity-100">
                    <Eye className="size-4" /> Walk through
                  </span>
                </Link>
              )}
            </div>
            <div className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">3D capture</p>
                  <p className="mt-1 text-lg font-medium">{tour ? SOURCE_LABEL[tour.source] : "No capture attached yet"}</p>
                  <p className="text-sm text-neutral-500">
                    {tour
                      ? `${floors.length} floor${floors.length === 1 ? "" : "s"} · ${roomCount} room${roomCount === 1 ? "" : "s"} with viewpoints`
                      : "Scan it with an iPhone, upload a .glb/.gltf model, or use the sample capture."}
                  </p>
                </div>
                {tour && (
                  <ButtonLink href={`/dashboard/properties/${p.id}/rooms`} variant="primary" size="sm">
                    <Pencil className="size-3.5" /> Rooms & viewpoints
                  </ButtonLink>
                )}
              </div>
              {tour && roomCount === 0 && (
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <MousePointerClick className="mt-0.5 size-4 shrink-0" /> This capture has no rooms yet. Open{" "}
                  <b className="font-semibold">Rooms & viewpoints</b> to walk the model and drop a viewpoint in each room.
                </p>
              )}
              {floors.length > 0 && roomCount > 0 && (
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  {floors.map((f) => (
                    <div key={f.id}>
                      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
                        <Layers className="size-3" /> {f.name}
                      </p>
                      <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                        {space!.rooms
                          .filter((r) => r.floorId === f.id)
                          .sort((a, b) => a.order - b.order)
                          .map((r) => (
                            <li key={r.id} className="flex items-center gap-2">
                              <span className="size-1 rounded-full bg-gold" /> {r.name}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-6 grid gap-3 border-t border-sand pt-6 sm:grid-cols-[1fr_auto] sm:items-start">
                <CaptureUploader propertyId={p.id} compact />
                <AttachDemoButton propertyId={p.id} replace={!!tour} />
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <PhoneCapturePanel propertyId={p.id} tourId={tour?.id ?? null} autoStart={scan === "1"} />
          </Card>

          {tour?.source === "ios_scan" && (
            <Card className="p-6">
              <PhotorealPanel
                propertyId={p.id}
                initialJob={photorealJob ? jobSummary(photorealJob) : null}
                gpuReady={gpuConfigured()}
                hasPhotoScan={!!tour.cleanAssetUrl}
              />
            </Card>
          )}

          <Card className="p-6 md:p-8">
            <PropertyForm mode="edit" action={updatePropertyAction.bind(null, p.id)} initial={p} />
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
          <Card className="p-6">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">Share</p>
            <div className="mt-4">
              <PublishPanel propertyId={p.id} slug={p.slug} published={live} hasCapture={!!tour && roomCount > 0} />
            </div>
          </Card>
          <Card className="p-6 text-sm text-neutral-600">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">How buyers see it</p>
            <ul className="mt-3 space-y-2">
              <li>• The link opens straight into the 3D home — no app, no sign-up.</li>
              <li>• Buyers glide room to room, look around, and walk by tapping the floor.</li>
              <li>• A live floor plan shows where they are on every level.</li>
            </ul>
          </Card>
          <div className="flex justify-end">
            <DeletePropertyButton propertyId={p.id} address={p.addressLine} />
          </div>
        </div>
      </div>
    </div>
  );
}
