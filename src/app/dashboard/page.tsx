import { Box, Eye, Pencil, Plus, ScanLine, Smartphone } from "lucide-react";
import Link from "next/link";
import { CopyLinkButton } from "@/components/dashboard/CopyLinkButton";
import { ButtonLink, Card, StatusPill } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getRepository } from "@/lib/data/repository";
import type { PropertySummary } from "@/lib/data/types";
import { cityLine, formatBaths, formatNumber, formatPrice } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Listings" };

export default async function DashboardPage() {
  const user = await requireUser();
  const listings = await (await getRepository()).listProperties(user.id);
  return (
    <div className="rise">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.24em] text-stone">Your listings</p>
          <h1 className="font-display mt-2 text-5xl leading-[1.05] text-ink">3D walkthroughs</h1>
          <p className="mt-3 max-w-xl text-[15px] text-neutral-600">Every listing becomes a walkthrough buyers can explore from anywhere — one link, no app.</p>
        </div>
        <ButtonLink href="/dashboard/properties/new" size="lg">
          <Plus className="size-4" /> New listing
        </ButtonLink>
      </div>

      {listings.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => (
            <ListingCard key={l.property.id} listing={l} />
          ))}
        </div>
      )}

      <CaptureComingSoon />
    </div>
  );
}

function ListingCard({ listing }: { listing: PropertySummary }) {
  const { property: p, tour, roomCount } = listing;
  const live = p.published && !!tour?.published;
  const tourHref = live ? `/tour/${p.slug}` : `/dashboard/properties/${p.id}/preview`;
  return (
    <Card className="group overflow-hidden">
      <Link href={`/dashboard/properties/${p.id}`} className="relative block aspect-[16/10] overflow-hidden bg-linen">
        {p.coverImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.coverImageUrl} alt="" className="size-full object-cover transition duration-700 group-hover:scale-[1.03]" />
        ) : (
          <div className="grid size-full place-items-center bg-[radial-gradient(circle_at_30%_20%,#fff,transparent_60%),linear-gradient(135deg,#efe9df,#e2d8c8)]">
            <Box className="size-10 text-stone/60" strokeWidth={1.2} />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/45 to-transparent" />
        <StatusPill published={live} className="absolute left-3 top-3 bg-white/95" />
        <span className="absolute bottom-3 left-3 rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          {tour ? `3D · ${roomCount} room${roomCount === 1 ? "" : "s"}` : "No 3D capture yet"}
        </span>
      </Link>
      <div className="p-5">
        <p className="font-display text-[26px] leading-none">{formatPrice(p.price)}</p>
        <h3 className="mt-2 truncate text-[15px] font-medium text-ink">{p.addressLine}</h3>
        <p className="truncate text-sm text-neutral-500">{cityLine(p)}</p>
        <p className="mt-3 text-[13px] text-neutral-500">
          {p.bedrooms} bd · {formatBaths(p.bathrooms)} ba · {formatNumber(p.squareFeet)} sq ft
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <ButtonLink href={tourHref} size="sm" variant="primary" target={live ? "_blank" : undefined} className={tour ? "" : "pointer-events-none opacity-40"}>
            <Eye className="size-4" /> {live ? "View tour" : "Preview"}
          </ButtonLink>
          <ButtonLink href={`/dashboard/properties/${p.id}`} size="sm" variant="secondary">
            <Pencil className="size-3.5" /> Edit
          </ButtonLink>
          <CopyLinkButton path={`/tour/${p.slug}`} disabled={!live} />
        </div>
      </div>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="mt-10 overflow-hidden">
      <div className="grid md:grid-cols-[1.1fr_1fr]">
        <div className="p-8 md:p-12">
          <span className="grid size-12 place-items-center rounded-2xl bg-linen">
            <Box className="size-6 text-gold" strokeWidth={1.5} />
          </span>
          <h2 className="font-display mt-6 text-4xl leading-tight">Create your first 3D listing</h2>
          <ol className="mt-5 space-y-2.5 text-[15px] text-neutral-600">
            <li>1. Add the address, price and details.</li>
            <li>2. Attach a 3D capture of the home.</li>
            <li>3. Publish and share one link with buyers.</li>
          </ol>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/dashboard/properties/new" size="lg">
              <Plus className="size-4" /> New listing
            </ButtonLink>
            <ButtonLink href="/tour/sample" target="_blank" variant="secondary" size="lg">
              <Eye className="size-4" /> See a sample tour
            </ButtonLink>
          </div>
        </div>
        <Link href="/tour/sample" target="_blank" className="relative hidden min-h-72 md:block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/demo/sheridan-road-cover.jpg" alt="Sample 3D walkthrough" className="absolute inset-0 size-full object-cover" />
          <span className="absolute bottom-4 left-4 rounded-full bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
            1234 Sheridan Road · sample
          </span>
        </Link>
      </div>
    </Card>
  );
}

function CaptureComingSoon() {
  return (
    <div className="mt-14 flex flex-col gap-4 rounded-3xl border border-dashed border-sand p-6 text-sm text-neutral-600 md:flex-row md:items-center md:gap-6">
      <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-white shadow-sm ring-1 ring-sand">
        <Smartphone className="size-5 text-ink" strokeWidth={1.5} />
      </span>
      <div className="flex-1">
        <p className="font-medium text-ink">Coming soon: capture with your iPhone</p>
        <p className="mt-0.5">
          Walk through the home once with the Atrium app (LiDAR + RoomPlan). Rooms, floors and the walkthrough path are created automatically — today&apos;s
          uploaded 3D captures use the exact same pipeline.
        </p>
      </div>
      <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-linen px-3 py-1 text-xs font-medium text-stone md:self-center">
        <ScanLine className="size-3.5" /> In development
      </span>
    </div>
  );
}
