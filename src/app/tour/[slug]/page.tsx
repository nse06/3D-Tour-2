import type { Metadata } from "next";
import { notFound } from "next/navigation";
import TourViewer from "@/components/tour/TourViewer";
import { bundleToTourData, getRepository } from "@/lib/data/repository";
import { SAMPLE_SLUG, sampleTour } from "@/lib/demo";

// Public, shareable tour page: /tour/1234-sheridan-road
export const dynamic = "force-dynamic";

async function loadTour(slug: string) {
  if (slug === SAMPLE_SLUG) return sampleTour();
  const bundle = await (await getRepository()).getPublishedBySlug(slug);
  return bundle ? bundleToTourData(bundle) : null;
}

export async function generateMetadata(props: PageProps<"/tour/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const tour = await loadTour(slug);
  if (!tour) return { title: "Tour not found" };
  const p = tour.property;
  return {
    title: `${p.addressLine} — 3D Walkthrough`,
    description: `Walk through ${p.addressLine}, ${p.city} in 3D. ${p.bedrooms} beds · ${p.bathrooms} baths.`,
    openGraph: p.coverImageUrl ? { images: [p.coverImageUrl] } : undefined,
  };
}

export default async function TourPage(props: PageProps<"/tour/[slug]">) {
  const { slug } = await props.params;
  const tour = await loadTour(slug);
  if (!tour) notFound();
  return <TourViewer data={tour} />;
}
