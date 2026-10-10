// Supabase (Postgres) persistence. By default every query runs with the
// signed-in realtor's session, so row-level security (supabase/migrations)
// enforces ownership; published tours are readable anonymously.
//
// The iPhone endpoints have no session and use a service-role client instead
// (getAdminRepository), which bypasses RLS. That is why every method below
// also filters by the owning user explicitly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultSpace } from "@/lib/tour/space";
import type { FloorFeature, NavLink, SplatSpot, TourAppearance, TourSpace, Vec2, Vec3 } from "@/lib/tour/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NotFoundError, uniqueSlug, type Repository } from "./repository";
import type {
  CaptureInput,
  CaptureSession,
  CaptureSessionLookup,
  PhotorealJob,
  PhotorealJobUpdate,
  Property,
  PropertyBundle,
  PropertyInput,
  PropertySummary,
  Tour,
} from "./types";

interface PropertyRow {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  address_line: string;
  city: string;
  state: string;
  postal_code: string;
  price: number;
  bedrooms: number;
  bathrooms: number;
  square_feet: number;
  description: string;
  cover_image_url: string | null;
  published: boolean;
  created_at: string;
  updated_at: string;
}

interface TourRow {
  id: string;
  property_id: string;
  asset_url: string;
  /** Added by migration 20261009000000; absent on databases that haven't run it yet. */
  clean_asset_url?: string | null;
  /** Added by migration 20261010000000 (photoreal splats). */
  splat_url?: string | null;
  splat_spots?: SplatSpot[] | null;
  asset_format: "glb" | "gltf";
  source: Tour["source"];
  scan_package_url: string | null;
  processing_status: Tour["processingStatus"];
  navigation: { links?: NavLink[]; eyeHeight?: number } | null;
  appearance?: TourAppearance;
  published: boolean;
  created_at: string;
}

interface CaptureSessionRow {
  id: string;
  property_id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
}

interface PhotorealJobRow {
  id: string;
  property_id: string;
  tour_id: string | null;
  user_id: string;
  status: PhotorealJob["status"];
  stage: string | null;
  progress: number;
  message: string | null;
  files: number;
  bytes: number | string;
  splat_url: string | null;
  stats: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface FloorRow {
  id: string;
  tour_id: string;
  name: string;
  floor_number: number;
  elevation: number;
  outline: Vec2[] | null;
  features: FloorFeature[] | null;
}

interface RoomRow {
  id: string;
  floor_id: string;
  name: string;
  sort_order: number;
  waypoint_position: Vec3;
  waypoint_rotation: { yaw: number; pitch: number };
  footprint: Vec2[] | null;
}

const toProperty = (r: PropertyRow): Property => ({
  id: r.id,
  userId: r.user_id,
  slug: r.slug,
  title: r.title,
  addressLine: r.address_line,
  city: r.city,
  state: r.state,
  postalCode: r.postal_code,
  price: Number(r.price),
  bedrooms: r.bedrooms,
  bathrooms: Number(r.bathrooms),
  squareFeet: r.square_feet,
  description: r.description,
  coverImageUrl: r.cover_image_url,
  published: r.published,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTour = (r: TourRow): Tour => ({
  id: r.id,
  propertyId: r.property_id,
  assetUrl: r.asset_url,
  cleanAssetUrl: r.clean_asset_url ?? null,
  splatUrl: r.splat_url ?? null,
  splatSpots: Array.isArray(r.splat_spots) ? r.splat_spots : null,
  assetFormat: r.asset_format,
  source: r.source,
  scanPackageUrl: r.scan_package_url,
  processingStatus: r.processing_status,
  navigation: { links: r.navigation?.links ?? [], eyeHeight: r.navigation?.eyeHeight ?? 1.6 },
  appearance: r.appearance === "captured" || r.appearance === "photoreal" ? r.appearance : "studio",
  published: r.published,
  createdAt: r.created_at,
});

const toCaptureSession = (r: CaptureSessionRow): CaptureSession => ({
  id: r.id,
  propertyId: r.property_id,
  userId: r.user_id,
  tokenHash: r.token_hash,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

const toPhotorealJob = (r: PhotorealJobRow): PhotorealJob => ({
  id: r.id,
  propertyId: r.property_id,
  tourId: r.tour_id,
  userId: r.user_id,
  status: r.status,
  stage: r.stage,
  progress: Number(r.progress),
  message: r.message,
  files: r.files,
  bytes: Number(r.bytes),
  splatUrl: r.splat_url,
  stats: r.stats,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST's answer when a table or column a request names isn't in the database (yet). */
const MISSING_SCHEMA = /PGRST20[45]|42P01|schema cache|does not exist/i;

/**
 * Runs `fn`; if the database predates a migration it needs (photoreal jobs, billing), applies the
 * migrations first (when this server reaches Postgres directly) and retries while the API reloads
 * its schema.
 */
export async function withMigrations<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof Error) || !MISSING_SCHEMA.test(e.message)) throw e;
    const { applyMigrations, databaseUrl } = await import("@/lib/migrations");
    if (!databaseUrl()) throw e;
    await applyMigrations();
    for (let attempt = 0; ; attempt++) {
      await new Promise((r) => setTimeout(r, 750));
      try {
        return await fn();
      } catch (again) {
        if (attempt >= 7 || !(again instanceof Error) || !MISSING_SCHEMA.test(again.message)) throw again;
      }
    }
  }
}

const fromInput = (input: PropertyInput) => ({
  title: input.title,
  address_line: input.addressLine,
  city: input.city,
  state: input.state,
  postal_code: input.postalCode,
  price: input.price,
  bedrooms: input.bedrooms,
  bathrooms: input.bathrooms,
  square_feet: input.squareFeet,
  description: input.description,
});

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

/** PostgREST's answer when a column the request names isn't in the database (yet). */
const MISSING_COLUMN = /PGRST204|clean_asset_url/;

export type SupabaseClientFactory = () => Promise<SupabaseClient>;

export class SupabaseRepository implements Repository {
  /** Defaults to the cookie-bound client of the current request (RLS applies). */
  constructor(private readonly client: SupabaseClientFactory = createSupabaseServerClient) {}

  private async loadSpace(db: SupabaseClient, tour: Tour): Promise<TourSpace> {
    const floors = check(await db.from("floors").select("*").eq("tour_id", tour.id).order("floor_number")) as FloorRow[];
    const floorIds = floors.map((f) => f.id);
    const rooms = floorIds.length ? (check(await db.from("rooms").select("*").in("floor_id", floorIds).order("sort_order")) as RoomRow[]) : [];
    const roomIds = new Set(rooms.map((r) => r.id));
    return {
      floors: floors.map((f) => ({
        id: f.id,
        name: f.name,
        level: f.floor_number,
        elevation: Number(f.elevation),
        outline: f.outline,
        features: f.features ?? [],
      })),
      rooms: rooms.map((r) => ({
        id: r.id,
        floorId: r.floor_id,
        name: r.name,
        order: r.sort_order,
        waypoint: { position: r.waypoint_position, yaw: r.waypoint_rotation?.yaw ?? 0, pitch: r.waypoint_rotation?.pitch ?? 0 },
        footprint: r.footprint,
      })),
      links: tour.navigation.links.filter((l) => roomIds.has(l.from) && roomIds.has(l.to)),
      eyeHeight: tour.navigation.eyeHeight,
    };
  }

  private async writeSpace(db: SupabaseClient, tourId: string, space: TourSpace) {
    check(await db.from("floors").delete().eq("tour_id", tourId));
    if (space.floors.length) {
      check(
        await db.from("floors").insert(
          space.floors.map((f) => ({
            id: f.id,
            tour_id: tourId,
            name: f.name,
            floor_number: f.level,
            elevation: f.elevation,
            outline: f.outline,
            features: f.features,
          })),
        ),
      );
    }
    if (space.rooms.length) {
      check(
        await db.from("rooms").insert(
          space.rooms.map((r) => ({
            id: r.id,
            floor_id: r.floorId,
            name: r.name,
            sort_order: r.order,
            waypoint_position: r.waypoint.position,
            waypoint_rotation: { yaw: r.waypoint.yaw, pitch: r.waypoint.pitch },
            footprint: r.footprint,
          })),
        ),
      );
    }
    check(
      await db
        .from("tours")
        .update({ navigation: { links: space.links, eyeHeight: space.eyeHeight } })
        .eq("id", tourId),
    );
  }

  private async ownedProperty(db: SupabaseClient, userId: string, propertyId: string): Promise<PropertyRow> {
    const row = check(await db.from("properties").select("*").eq("id", propertyId).eq("user_id", userId).maybeSingle()) as PropertyRow | null;
    if (!row) throw new NotFoundError();
    return row;
  }

  private async latestTour(db: SupabaseClient, propertyId: string, publishedOnly = false): Promise<Tour | null> {
    let q = db.from("tours").select("*").eq("property_id", propertyId);
    if (publishedOnly) q = q.eq("published", true);
    const row = check(await q.order("created_at", { ascending: false }).limit(1).maybeSingle()) as TourRow | null;
    return row ? toTour(row) : null;
  }

  async listProperties(userId: string): Promise<PropertySummary[]> {
    const db = await this.client();
    const rows = check(await db.from("properties").select("*").eq("user_id", userId).order("created_at", { ascending: false })) as PropertyRow[];
    if (!rows.length) return [];
    const tours = check(
      await db
        .from("tours")
        .select("id, property_id, source, processing_status, published, created_at, floors(id, rooms(id))")
        .in(
          "property_id",
          rows.map((r) => r.id),
        ),
    ) as unknown as (TourRow & { floors: { id: string; rooms: { id: string }[] }[] })[];
    return rows.map((r) => {
      const tour = tours.filter((t) => t.property_id === r.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return {
        property: toProperty(r),
        tour: tour ? { id: tour.id, source: tour.source, processingStatus: tour.processing_status, published: tour.published } : null,
        floorCount: tour?.floors?.length ?? 0,
        roomCount: tour?.floors?.reduce((n, f) => n + (f.rooms?.length ?? 0), 0) ?? 0,
      };
    });
  }

  async getProperty(userId: string, propertyId: string): Promise<PropertyBundle | null> {
    const db = await this.client();
    const row = check(await db.from("properties").select("*").eq("id", propertyId).eq("user_id", userId).maybeSingle()) as PropertyRow | null;
    if (!row) return null;
    const tour = await this.latestTour(db, row.id);
    return { property: toProperty(row), tour, space: tour ? await this.loadSpace(db, tour) : null };
  }

  async createProperty(userId: string, input: PropertyInput): Promise<Property> {
    const db = await this.client();
    // Slugs are globally unique; look up collisions through a security-definer helper.
    const base = uniqueSlug(input.addressLine, () => false);
    const { data: free } = await db.rpc("available_slug", { base });
    const slug = typeof free === "string" && free ? free : `${base}-${Date.now().toString(36)}`;
    const row = check(
      await db
        .from("properties")
        .insert({ ...fromInput(input), user_id: userId, slug })
        .select("*")
        .single(),
    ) as PropertyRow;
    return toProperty(row);
  }

  async updateProperty(userId: string, propertyId: string, input: PropertyInput): Promise<Property> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    const row = check(
      await db
        .from("properties")
        .update({ ...fromInput(input), updated_at: new Date().toISOString() })
        .eq("id", propertyId)
        .eq("user_id", userId)
        .select("*")
        .single(),
    ) as PropertyRow;
    return toProperty(row);
  }

  async deleteProperty(userId: string, propertyId: string): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    check(await db.from("properties").delete().eq("id", propertyId).eq("user_id", userId));
  }

  async setPublished(userId: string, propertyId: string, published: boolean): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    const tour = await this.latestTour(db, propertyId);
    if (published && !tour) throw new Error("Attach a 3D capture before publishing.");
    if (tour) check(await db.from("tours").update({ published }).eq("id", tour.id));
    check(await db.from("properties").update({ published, updated_at: new Date().toISOString() }).eq("id", propertyId).eq("user_id", userId));
  }

  async setCoverImage(userId: string, propertyId: string, url: string | null): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    check(await db.from("properties").update({ cover_image_url: url, updated_at: new Date().toISOString() }).eq("id", propertyId).eq("user_id", userId));
  }

  async attachCapture(userId: string, propertyId: string, capture: CaptureInput): Promise<void> {
    const db = await this.client();
    const property = await this.ownedProperty(db, userId, propertyId);
    check(await db.from("tours").delete().eq("property_id", propertyId));
    const space = capture.space ?? defaultSpace();
    const row: Record<string, unknown> = {
      property_id: propertyId,
      asset_url: capture.assetUrl,
      asset_format: capture.assetFormat,
      source: capture.source,
      scan_package_url: capture.scanPackageUrl ?? null,
      appearance: capture.appearance ?? "studio",
      processing_status: "ready",
      navigation: { links: [], eyeHeight: space.eyeHeight },
      published: property.published,
    };
    if (capture.cleanAssetUrl) row.clean_asset_url = capture.cleanAssetUrl;
    const insert = () => db.from("tours").insert(row).select("*").single();
    let result = await insert();
    if (result.error && row.clean_asset_url && MISSING_COLUMN.test(`${result.error.code} ${result.error.message}`)) {
      // A database set up before the clean model existed: add the column (when this server
      // reaches Postgres directly) and retry while the API reloads its schema; at worst the
      // tour goes up without its "photos off" view rather than not at all.
      const { applyMigrations, databaseUrl } = await import("@/lib/migrations");
      if (databaseUrl()) {
        await applyMigrations().catch((e) => console.error("could not add the clean model column:", (e as Error).message));
        for (let attempt = 0; attempt < 8 && result.error; attempt++) {
          await new Promise((r) => setTimeout(r, 750));
          result = await insert();
        }
      }
      if (result.error && MISSING_COLUMN.test(`${result.error.code} ${result.error.message}`)) {
        delete row.clean_asset_url;
        result = await insert();
      }
    }
    const tour = check(result) as TourRow;
    await this.writeSpace(db, tour.id, space);
  }

  async saveSpace(userId: string, propertyId: string, space: TourSpace): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    const tour = await this.latestTour(db, propertyId);
    if (!tour) throw new NotFoundError("Tour");
    await this.writeSpace(db, tour.id, space);
  }

  async setAppearance(userId: string, propertyId: string, appearance: TourAppearance): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    const tour = await this.latestTour(db, propertyId);
    if (!tour) throw new NotFoundError("Tour");
    check(await db.from("tours").update({ appearance }).eq("id", tour.id).eq("property_id", propertyId));
  }

  async getPublishedBySlug(slug: string): Promise<PropertyBundle | null> {
    const db = await this.client();
    const row = check(await db.from("properties").select("*").eq("slug", slug).eq("published", true).maybeSingle()) as PropertyRow | null;
    if (!row) return null;
    const tour = await this.latestTour(db, row.id, true);
    if (!tour) return null;
    return { property: toProperty(row), tour, space: await this.loadSpace(db, tour) };
  }

  async createCaptureSession(userId: string, propertyId: string, input: Pick<CaptureSession, "tokenHash" | "expiresAt">): Promise<CaptureSession> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    // Housekeeping: forget this realtor's expired sessions.
    check(await db.from("capture_sessions").delete().eq("user_id", userId).lt("expires_at", new Date().toISOString()));
    const row = check(
      await db
        .from("capture_sessions")
        .insert({ property_id: propertyId, user_id: userId, token_hash: input.tokenHash, expires_at: input.expiresAt })
        .select("*")
        .single(),
    ) as CaptureSessionRow;
    return toCaptureSession(row);
  }

  async findCaptureSessionByTokenHash(tokenHash: string): Promise<CaptureSessionLookup | null> {
    const db = await this.client();
    const row = check(
      await db.from("capture_sessions").select("*").eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle(),
    ) as CaptureSessionRow | null;
    if (!row) return null;
    // The session's realtor must still own the listing.
    const property = check(
      await db.from("properties").select("id, address_line, city, state").eq("id", row.property_id).eq("user_id", row.user_id).maybeSingle(),
    ) as Pick<PropertyRow, "id" | "address_line" | "city" | "state"> | null;
    if (!property) return null;
    return {
      session: toCaptureSession(row),
      property: { id: property.id, addressLine: property.address_line, city: property.city, state: property.state },
    };
  }

  async completeCaptureSession(userId: string, sessionId: string): Promise<void> {
    const db = await this.client();
    const row = check(
      await db.from("capture_sessions").update({ completed_at: new Date().toISOString() }).eq("id", sessionId).eq("user_id", userId).select("id").maybeSingle(),
    );
    if (!row) throw new NotFoundError("Capture session");
  }

  async createPhotorealJob(userId: string, propertyId: string, input: { files: number; bytes: number }): Promise<PhotorealJob | null> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    const tour = await this.latestTour(db, propertyId);
    if (!tour) return null;
    return withMigrations(async () => {
      const row = check(
        await db
          .from("photoreal_jobs")
          .insert({ property_id: propertyId, tour_id: tour.id, user_id: userId, status: "uploading", files: input.files, bytes: input.bytes })
          .select("*")
          .single(),
      ) as PhotorealJobRow;
      return toPhotorealJob(row);
    });
  }

  async getPhotorealJob(jobId: string): Promise<PhotorealJob | null> {
    if (!UUID.test(jobId)) return null;
    const db = await this.client();
    return withMigrations(async () => {
      const row = check(await db.from("photoreal_jobs").select("*").eq("id", jobId).maybeSingle()) as PhotorealJobRow | null;
      return row ? toPhotorealJob(row) : null;
    });
  }

  async updatePhotorealJob(jobId: string, update: PhotorealJobUpdate): Promise<PhotorealJob | null> {
    if (!UUID.test(jobId)) return null;
    const db = await this.client();
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (update.status !== undefined) row.status = update.status;
    if (update.stage !== undefined) row.stage = update.stage;
    if (update.progress !== undefined) row.progress = update.progress;
    if (update.message !== undefined) row.message = update.message;
    if (update.splatUrl !== undefined) row.splat_url = update.splatUrl;
    if (update.stats !== undefined) row.stats = update.stats;
    if (update.startedAt !== undefined) row.started_at = update.startedAt;
    if (update.finishedAt !== undefined) row.finished_at = update.finishedAt;
    return withMigrations(async () => {
      const result = check(await db.from("photoreal_jobs").update(row).eq("id", jobId).select("*").maybeSingle()) as PhotorealJobRow | null;
      return result ? toPhotorealJob(result) : null;
    });
  }

  async latestPhotorealJob(userId: string, propertyId: string): Promise<PhotorealJob | null> {
    const db = await this.client();
    return withMigrations(async () => {
      const row = check(
        await db
          .from("photoreal_jobs")
          .select("*")
          .eq("property_id", propertyId)
          .eq("user_id", userId)
          .not("tour_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ) as PhotorealJobRow | null;
      return row ? toPhotorealJob(row) : null;
    });
  }

  async attachSplats(job: PhotorealJob, splatUrl: string, spots: SplatSpot[] | null): Promise<boolean> {
    if (!job.tourId) return false;
    const db = await this.client();
    const attach = async (withSpots: boolean) =>
      check(
        await db
          .from("tours")
          .update(withSpots ? { splat_url: splatUrl, splat_spots: spots } : { splat_url: splatUrl })
          .eq("id", job.tourId!)
          .eq("property_id", job.propertyId)
          .select("id")
          .maybeSingle(),
      );
    try {
      // A database from before splat_spots gets the column here when this server reaches Postgres.
      return await withMigrations(async () => !!(await attach(true)));
    } catch (e) {
      // Otherwise the splats still go on the tour, and the viewer judges close-ups by distance alone.
      if (!(e instanceof Error) || !/splat_spots/.test(e.message)) throw e;
      console.error("photoreal: tours.splat_spots is missing (open /setup); attaching the splats without their photo spots");
      return withMigrations(async () => !!(await attach(false)));
    }
  }
}
