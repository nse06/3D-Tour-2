import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { RoomEditor } from "@/components/dashboard/RoomEditor";
import { requireUser } from "@/lib/auth";
import { getRepository } from "@/lib/data/repository";
import { defaultSpace } from "@/lib/tour/space";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rooms & viewpoints" };

export default async function RoomsPage(props: PageProps<"/dashboard/properties/[id]/rooms">) {
  const { id } = await props.params;
  const user = await requireUser();
  const bundle = await (await getRepository()).getProperty(user.id, id);
  if (!bundle) notFound();
  if (!bundle.tour) redirect(`/dashboard/properties/${id}`);
  const space = bundle.space && bundle.space.floors.length ? bundle.space : defaultSpace();
  return (
    <div className="rise">
      <Link href={`/dashboard/properties/${id}`} className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-ink">
        <ArrowLeft className="size-4" /> {bundle.property.addressLine}
      </Link>
      <h1 className="font-display mt-3 text-4xl leading-tight md:text-5xl">Rooms & viewpoints</h1>
      <p className="mt-2 max-w-2xl text-[15px] text-neutral-600">
        Walk the 3D capture and choose what buyers see in each room. The order here is the guided walkthrough order.
      </p>
      <div className="mt-8">
        <RoomEditor propertyId={id} assetUrl={bundle.tour.assetUrl} initialSpace={space} />
      </div>
    </div>
  );
}
