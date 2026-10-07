import { slugify } from "@/lib/format";
import type { TourData, TourSpace } from "@/lib/tour/types";
import { isSupabaseConfigured } from "./config";
import type { CaptureInput, Property, PropertyBundle, PropertyInput, PropertySummary } from "./types";

/**
 * Storage-agnostic persistence API. Two implementations:
 *  - LocalRepository: JSON file on disk (zero-config local development / demos)
 *  - SupabaseRepository: Postgres + RLS (production, Vercel)
 */
export interface Repository {
  listProperties(userId: string): Promise<PropertySummary[]>;
  getProperty(userId: string, propertyId: string): Promise<PropertyBundle | null>;
  createProperty(userId: string, input: PropertyInput): Promise<Property>;
  updateProperty(userId: string, propertyId: string, input: PropertyInput): Promise<Property>;
  deleteProperty(userId: string, propertyId: string): Promise<void>;
  setPublished(userId: string, propertyId: string, published: boolean): Promise<void>;
  setCoverImage(userId: string, propertyId: string, url: string | null): Promise<void>;
  /** Replace the property's capture (one active tour per property in the MVP). */
  attachCapture(userId: string, propertyId: string, capture: CaptureInput): Promise<void>;
  /** Replace floors/rooms/links of the property's tour (room editor). */
  saveSpace(userId: string, propertyId: string, space: TourSpace): Promise<void>;
  getPublishedBySlug(slug: string): Promise<PropertyBundle | null>;
}

let repo: Promise<Repository> | null = null;

export function getRepository(): Promise<Repository> {
  if (!repo) {
    repo = isSupabaseConfigured()
      ? import("./supabase-store").then((m) => new m.SupabaseRepository())
      : import("./local-store").then((m) => new m.LocalRepository());
  }
  return repo;
}

export function bundleToTourData(bundle: PropertyBundle): TourData | null {
  const { property, tour, space } = bundle;
  if (!tour || !space) return null;
  return {
    property: {
      slug: property.slug,
      title: property.title,
      addressLine: property.addressLine,
      city: property.city,
      state: property.state,
      postalCode: property.postalCode,
      price: property.price,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      squareFeet: property.squareFeet,
      description: property.description,
      coverImageUrl: property.coverImageUrl,
    },
    assetUrl: tour.assetUrl,
    source: tour.source,
    space,
  };
}

/** Slugs are derived from the street address: "1234 Sheridan Road" → "1234-sheridan-road". */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  const root = slugify(base) || "property";
  const reserved = new Set(["sample", "new", "demo"]);
  let slug = root;
  let n = 2;
  while (reserved.has(slug) || taken(slug)) slug = `${root}-${n++}`;
  return slug;
}

export class NotFoundError extends Error {
  constructor(what = "Property") {
    super(`${what} not found`);
  }
}
