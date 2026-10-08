import { slugify } from "@/lib/format";
import type { TourAppearance, TourData, TourSpace } from "@/lib/tour/types";
import { isSupabaseConfigured, supabaseAdminKey } from "./config";
import type { CaptureInput, CaptureSession, CaptureSessionLookup, Property, PropertyBundle, PropertyInput, PropertySummary } from "./types";

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
  /** How the viewer lights the property's capture. */
  setAppearance(userId: string, propertyId: string, appearance: TourAppearance): Promise<void>;
  getPublishedBySlug(slug: string): Promise<PropertyBundle | null>;

  // iPhone capture pairing (see docs/iphone-capture.md §3).
  createCaptureSession(userId: string, propertyId: string, input: Pick<CaptureSession, "tokenHash" | "expiresAt">): Promise<CaptureSession>;
  /** The unexpired session with this token hash, or null. Needs no user: the phone only has the token. */
  findCaptureSessionByTokenHash(tokenHash: string): Promise<CaptureSessionLookup | null>;
  completeCaptureSession(userId: string, sessionId: string): Promise<void>;
}

let repo: Promise<Repository> | null = null;
let adminRepo: Promise<Repository> | null = null;

export function getRepository(): Promise<Repository> {
  if (!repo) {
    repo = isSupabaseConfigured()
      ? import("./supabase-store").then((m) => new m.SupabaseRepository())
      : import("./local-store").then((m) => new m.LocalRepository());
  }
  return repo;
}

/** The server is missing configuration that a feature needs (HTTP 503). */
export class ConfigurationError extends Error {}

/** Why the phone endpoints can't work on this server, or null when they can. */
export function adminRepositoryUnavailableReason(): string | null {
  if (isSupabaseConfigured() && !supabaseAdminKey()) {
    return "iPhone uploads need SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY). Add it to the server's environment variables (see .env.example) and redeploy.";
  }
  return null;
}

/**
 * Repository for requests without a realtor session: the iPhone app, which
 * authenticates with a capture-session token. Local mode has no RLS, so this
 * is the regular store. In Supabase mode it uses the service-role key, which
 * bypasses RLS — every query on this path filters by the owning user itself.
 */
export function getAdminRepository(): Promise<Repository> {
  if (!isSupabaseConfigured()) return getRepository();
  const unavailable = adminRepositoryUnavailableReason();
  if (unavailable) return Promise.reject(new ConfigurationError(unavailable));
  if (!adminRepo) {
    adminRepo = Promise.all([import("./supabase-store"), import("@/lib/supabase/admin")]).then(
      ([store, admin]) => new store.SupabaseRepository(async () => admin.createSupabaseAdminClient()),
    );
  }
  return adminRepo;
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
    cleanAssetUrl: tour.cleanAssetUrl ?? null,
    source: tour.source,
    appearance: tour.appearance ?? "studio",
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
