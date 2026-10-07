// Zero-config persistence: a JSON document on disk. Good for local
// development and demos; use Supabase for anything shared or deployed.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultSpace } from "@/lib/tour/space";
import type { TourSpace } from "@/lib/tour/types";
import { localDataDir } from "./config";
import { NotFoundError, uniqueSlug, type Repository } from "./repository";
import type { CaptureInput, FloorRecord, Property, PropertyBundle, PropertyInput, PropertySummary, RoomRecord, Tour } from "./types";

interface Db {
  version: 1;
  properties: Property[];
  tours: Tour[];
  floors: FloorRecord[];
  rooms: RoomRecord[];
}

const empty = (): Db => ({ version: 1, properties: [], tours: [], floors: [], rooms: [] });

let queue: Promise<unknown> = Promise.resolve();

function dbFile() {
  return path.join(localDataDir(), "db.json");
}

async function readDb(): Promise<Db> {
  try {
    const raw = await fs.readFile(dbFile(), "utf8");
    return { ...empty(), ...JSON.parse(raw) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw e;
  }
}

async function writeDb(db: Db) {
  await fs.mkdir(localDataDir(), { recursive: true });
  const tmp = `${dbFile()}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, dbFile());
}

/** Serialize read-modify-write cycles within this process. */
function mutate<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

const now = () => new Date().toISOString();

function owned(db: Db, userId: string, propertyId: string): Property {
  const p = db.properties.find((x) => x.id === propertyId && x.userId === userId);
  if (!p) throw new NotFoundError();
  return p;
}

function spaceFor(db: Db, tour: Tour | undefined): TourSpace | null {
  if (!tour) return null;
  const floors = db.floors.filter((f) => f.tourId === tour.id).sort((a, b) => a.level - b.level);
  const floorIds = new Set(floors.map((f) => f.id));
  const rooms = db.rooms.filter((r) => floorIds.has(r.floorId)).sort((a, b) => a.order - b.order);
  const roomIds = new Set(rooms.map((r) => r.id));
  return {
    floors: floors.map((f) => ({ id: f.id, name: f.name, level: f.level, elevation: f.elevation, outline: f.outline, features: f.features })),
    rooms,
    links: (tour.navigation?.links ?? []).filter((l) => roomIds.has(l.from) && roomIds.has(l.to)),
    eyeHeight: tour.navigation?.eyeHeight ?? 1.6,
  };
}

function replaceSpace(db: Db, tour: Tour, space: TourSpace) {
  const oldFloors = new Set(db.floors.filter((f) => f.tourId === tour.id).map((f) => f.id));
  db.floors = db.floors.filter((f) => f.tourId !== tour.id);
  db.rooms = db.rooms.filter((r) => !oldFloors.has(r.floorId));
  db.floors.push(...space.floors.map((f) => ({ ...f, tourId: tour.id })));
  const floorIds = new Set(space.floors.map((f) => f.id));
  db.rooms.push(...space.rooms.filter((r) => floorIds.has(r.floorId)));
  tour.navigation = { links: space.links, eyeHeight: space.eyeHeight };
}

export class LocalRepository implements Repository {
  async listProperties(userId: string): Promise<PropertySummary[]> {
    const db = await readDb();
    return db.properties
      .filter((p) => p.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((property) => {
        const tour = db.tours.find((t) => t.propertyId === property.id);
        const space = spaceFor(db, tour);
        return {
          property,
          tour: tour ? { id: tour.id, source: tour.source, processingStatus: tour.processingStatus, published: tour.published } : null,
          roomCount: space?.rooms.length ?? 0,
          floorCount: space?.floors.length ?? 0,
        };
      });
  }

  async getProperty(userId: string, propertyId: string): Promise<PropertyBundle | null> {
    const db = await readDb();
    const property = db.properties.find((p) => p.id === propertyId && p.userId === userId);
    if (!property) return null;
    const tour = db.tours.find((t) => t.propertyId === property.id) ?? null;
    return { property, tour, space: spaceFor(db, tour ?? undefined) };
  }

  createProperty(userId: string, input: PropertyInput): Promise<Property> {
    return mutate((db) => {
      const property: Property = {
        id: randomUUID(),
        userId,
        slug: uniqueSlug(input.addressLine, (s) => db.properties.some((p) => p.slug === s)),
        ...input,
        coverImageUrl: null,
        published: false,
        createdAt: now(),
        updatedAt: now(),
      };
      db.properties.push(property);
      return property;
    });
  }

  updateProperty(userId: string, propertyId: string, input: PropertyInput): Promise<Property> {
    return mutate((db) => {
      const p = owned(db, userId, propertyId);
      Object.assign(p, input, { updatedAt: now() });
      return p;
    });
  }

  deleteProperty(userId: string, propertyId: string): Promise<void> {
    return mutate((db) => {
      owned(db, userId, propertyId);
      const tourIds = new Set(db.tours.filter((t) => t.propertyId === propertyId).map((t) => t.id));
      const floorIds = new Set(db.floors.filter((f) => tourIds.has(f.tourId)).map((f) => f.id));
      db.rooms = db.rooms.filter((r) => !floorIds.has(r.floorId));
      db.floors = db.floors.filter((f) => !tourIds.has(f.tourId));
      db.tours = db.tours.filter((t) => !tourIds.has(t.id));
      db.properties = db.properties.filter((p) => p.id !== propertyId);
    });
  }

  setPublished(userId: string, propertyId: string, published: boolean): Promise<void> {
    return mutate((db) => {
      const p = owned(db, userId, propertyId);
      const tour = db.tours.find((t) => t.propertyId === propertyId);
      if (published && !tour) throw new Error("Attach a 3D capture before publishing.");
      p.published = published;
      p.updatedAt = now();
      if (tour) tour.published = published;
    });
  }

  setCoverImage(userId: string, propertyId: string, url: string | null): Promise<void> {
    return mutate((db) => {
      const p = owned(db, userId, propertyId);
      p.coverImageUrl = url;
      p.updatedAt = now();
    });
  }

  attachCapture(userId: string, propertyId: string, capture: CaptureInput): Promise<void> {
    return mutate((db) => {
      const p = owned(db, userId, propertyId);
      const previous = db.tours.find((t) => t.propertyId === propertyId);
      if (previous) {
        replaceSpace(db, previous, { floors: [], rooms: [], links: [], eyeHeight: 1.6 });
        db.tours = db.tours.filter((t) => t.id !== previous.id);
      }
      const tour: Tour = {
        id: randomUUID(),
        propertyId,
        assetUrl: capture.assetUrl,
        assetFormat: capture.assetFormat,
        source: capture.source,
        scanPackageUrl: null,
        processingStatus: "ready",
        navigation: { links: [], eyeHeight: 1.6 },
        published: p.published,
        createdAt: now(),
      };
      db.tours.push(tour);
      replaceSpace(db, tour, capture.space ?? defaultSpace());
      p.updatedAt = now();
    });
  }

  saveSpace(userId: string, propertyId: string, space: TourSpace): Promise<void> {
    return mutate((db) => {
      owned(db, userId, propertyId);
      const tour = db.tours.find((t) => t.propertyId === propertyId);
      if (!tour) throw new NotFoundError("Tour");
      replaceSpace(db, tour, space);
    });
  }

  async getPublishedBySlug(slug: string): Promise<PropertyBundle | null> {
    const db = await readDb();
    const property = db.properties.find((p) => p.slug === slug && p.published);
    if (!property) return null;
    const tour = db.tours.find((t) => t.propertyId === property.id && t.published) ?? null;
    if (!tour) return null;
    return { property, tour, space: spaceFor(db, tour) };
  }
}

