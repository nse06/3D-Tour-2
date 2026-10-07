import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { PropertyForm } from "@/components/dashboard/PropertyForm";
import { Card } from "@/components/ui";
import { createPropertyAction } from "../../actions";

export const metadata = { title: "New listing" };

export default function NewPropertyPage() {
  return (
    <div className="rise mx-auto max-w-3xl">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-ink">
        <ArrowLeft className="size-4" /> Listings
      </Link>
      <h1 className="font-display mt-4 text-5xl leading-tight">New listing</h1>
      <p className="mt-2 text-[15px] text-neutral-600">Add the property, attach its 3D capture, then preview and publish.</p>
      <Card className="mt-8 p-6 md:p-10">
        <PropertyForm mode="create" action={createPropertyAction} />
      </Card>
    </div>
  );
}
