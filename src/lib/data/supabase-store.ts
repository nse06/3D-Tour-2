// Supabase (Postgres) persistence. Every query runs with the signed-in
// realtor's session, so row-level security (supabase/migrations) enforces
// ownership; published tours are readable anonymously.

import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultSpace } from "@/lib/tour/space";
import type { FloorFeature, NavLink, TourSpace, Vec2, Vec3 } from "@/lib/tour/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NotFoundError, uniqueSlug, type Repository } from "./repository";
import type { CaptureInput, Property, PropertyBundle, PropertyInput, PropertySummary, Tour } from "./types";

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
  asset_format: "glb" | "gltf";
  source: Tour["source"];
  scan_package_url: string | null;
  processing_status: Tour["processingStatus"];
  navigation: { links?: NavLink[]; eyeHeight?: number } | null;
  published: boolean;
  created_at: string;
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
  assetFormat: r.asset_format,
  source: r.source,
  scanPackageUrl: r.scan_package_url,
  processingStatus: r.processing_status,
  navigation: { links: r.navigation?.links ?? [], eyeHeight: r.navigation?.eyeHeight ?? 1.6 },
  published: r.published,
  createdAt: r.created_at,
});

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

export class SupabaseRepository implements Repository {
  private client(): Promise<SupabaseClient> {
    return createSupabaseServerClient();
  }

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
        .select("*")
        .single(),
    ) as PropertyRow;
    return toProperty(row);
  }

  async deleteProperty(userId: string, propertyId: string): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    check(await db.from("properties").delete().eq("id", propertyId));
  }

  async setPublished(userId: string, propertyId: string, published: boolean): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    const tour = await this.latestTour(db, propertyId);
    if (published && !tour) throw new Error("Attach a 3D capture before publishing.");
    if (tour) check(await db.from("tours").update({ published }).eq("id", tour.id));
    check(await db.from("properties").update({ published, updated_at: new Date().toISOString() }).eq("id", propertyId));
  }

  async setCoverImage(userId: string, propertyId: string, url: string | null): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    check(await db.from("properties").update({ cover_image_url: url, updated_at: new Date().toISOString() }).eq("id", propertyId));
  }

  async attachCapture(userId: string, propertyId: string, capture: CaptureInput): Promise<void> {
    const db = await this.client();
    const property = await this.ownedProperty(db, userId, propertyId);
    check(await db.from("tours").delete().eq("property_id", propertyId));
    const space = capture.space ?? defaultSpace();
    const tour = check(
      await db
        .from("tours")
        .insert({
          property_id: propertyId,
          asset_url: capture.assetUrl,
          asset_format: capture.assetFormat,
          source: capture.source,
          processing_status: "ready",
          navigation: { links: [], eyeHeight: space.eyeHeight },
          published: property.published,
        })
        .select("*")
        .single(),
    ) as TourRow;
    await this.writeSpace(db, tour.id, space);
  }

  async saveSpace(userId: string, propertyId: string, space: TourSpace): Promise<void> {
    const db = await this.client();
    await this.ownedProperty(db, userId, propertyId);
    const tour = await this.latestTour(db, propertyId);
    if (!tour) throw new NotFoundError("Tour");
    await this.writeSpace(db, tour.id, space);
  }

  async getPublishedBySlug(slug: string): Promise<PropertyBundle | null> {
    const db = await this.client();
    const row = check(await db.from("properties").select("*").eq("slug", slug).eq("published", true).maybeSingle()) as PropertyRow | null;
    if (!row) return null;
    const tour = await this.latestTour(db, row.id, true);
    if (!tour) return null;
    return { property: toProperty(row), tour, space: await this.loadSpace(db, tour) };
  }
}
