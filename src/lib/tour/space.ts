import type { FloorFeature, NavLink, TourFloor, TourRoom, TourSpace, Vec2, Vec3, Waypoint } from "./types";

export const newId = () => globalThis.crypto.randomUUID();

export function defaultSpace(): TourSpace {
  return {
    floors: [{ id: newId(), name: "Main Level", level: 1, elevation: 0, outline: null, features: [] }],
    rooms: [],
    links: [],
    eyeHeight: 1.6,
  };
}

// ---------------------------------------------------------------------------
// Validation of client-submitted spatial data (room editor saves).
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 10_000;

class SpaceError extends Error {}

function num(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > LIMIT) throw new SpaceError(`Invalid ${label}`);
  return v;
}
function str(v: unknown, label: string, max = 80): string {
  if (typeof v !== "string") throw new SpaceError(`Invalid ${label}`);
  const s = v.trim().slice(0, max);
  if (!s) throw new SpaceError(`${label} is required`);
  return s;
}
function id(v: unknown, label: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new SpaceError(`Invalid ${label}`);
  return v;
}
function vec3(v: unknown, label: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) throw new SpaceError(`Invalid ${label}`);
  return [num(v[0], label), num(v[1], label), num(v[2], label)];
}
function poly(v: unknown, label: string): Vec2[] | null {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > 512) throw new SpaceError(`Invalid ${label}`);
  return v.map((p) => {
    if (!Array.isArray(p) || p.length !== 2) throw new SpaceError(`Invalid ${label}`);
    return [num(p[0], label), num(p[1], label)] as Vec2;
  });
}
function waypoint(v: unknown): Waypoint {
  const w = v as Waypoint;
  if (!w || typeof w !== "object") throw new SpaceError("Invalid waypoint");
  return { position: vec3(w.position, "waypoint position"), yaw: num(w.yaw, "yaw"), pitch: num(w.pitch, "pitch") };
}
function features(v: unknown): FloorFeature[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 32).map((f) => {
    const type = (f as FloorFeature).type === "stairs" ? "stairs" : "void";
    const out: FloorFeature = { type, polygon: poly((f as FloorFeature).polygon, "feature") ?? [] };
    if (typeof (f as FloorFeature).label === "string") out.label = (f as FloorFeature).label!.slice(0, 40);
    if ((f as FloorFeature).direction === "up" || (f as FloorFeature).direction === "down") out.direction = (f as FloorFeature).direction;
    if (typeof (f as FloorFeature).treads === "number") out.treads = Math.min(64, Math.max(1, Math.round((f as FloorFeature).treads!)));
    return out;
  });
}

/** Parse and normalize a TourSpace from untrusted input. Throws on invalid data. */
export function parseSpace(input: unknown): TourSpace {
  const s = input as TourSpace;
  if (!s || typeof s !== "object" || !Array.isArray(s.floors) || !Array.isArray(s.rooms)) throw new SpaceError("Invalid space");
  if (s.floors.length === 0 || s.floors.length > 12) throw new SpaceError("A tour needs between 1 and 12 floors");
  if (s.rooms.length > 200) throw new SpaceError("Too many rooms");
  const floors: TourFloor[] = s.floors.map((f) => ({
    id: id(f.id, "floor id"),
    name: str(f.name, "Floor name"),
    level: Math.round(num(f.level, "floor level")),
    elevation: num(f.elevation, "floor elevation"),
    outline: poly(f.outline, "floor outline"),
    features: features(f.features),
  }));
  const floorIds = new Set(floors.map((f) => f.id));
  const rooms: TourRoom[] = s.rooms.map((r, i) => {
    const floorId = id(r.floorId, "room floor");
    if (!floorIds.has(floorId)) throw new SpaceError("Room references an unknown floor");
    return {
      id: id(r.id, "room id"),
      floorId,
      name: str(r.name, "Room name"),
      order: Number.isFinite(r.order) ? Math.round(r.order) : i,
      waypoint: waypoint(r.waypoint),
      footprint: poly(r.footprint, "room footprint"),
    };
  });
  const roomIds = new Set(rooms.map((r) => r.id));
  const links: NavLink[] = (Array.isArray(s.links) ? s.links : [])
    .filter((l) => roomIds.has(l?.from) && roomIds.has(l?.to))
    .slice(0, 500)
    .map((l) => ({
      from: l.from,
      to: l.to,
      via: (Array.isArray(l.via) ? l.via : []).slice(0, 32).map((p) => vec3(p, "link point")),
      ...(l.kind === "stairs" || l.kind === "door" ? { kind: l.kind } : {}),
    }));
  const eyeHeight = typeof s.eyeHeight === "number" && s.eyeHeight > 0.5 && s.eyeHeight < 3 ? s.eyeHeight : 1.6;
  return { floors, rooms, links, eyeHeight };
}

export function isSpaceError(e: unknown): e is Error {
  return e instanceof SpaceError;
}

/** Re-key a space with fresh UUIDs (used when importing a manifest into the database). */
export function withFreshIds(space: TourSpace): TourSpace {
  const map = new Map<string, string>();
  const fresh = (old: string) => {
    if (!map.has(old)) map.set(old, newId());
    return map.get(old)!;
  };
  return {
    floors: space.floors.map((f) => ({ ...f, id: fresh(f.id) })),
    rooms: space.rooms.map((r) => ({ ...r, id: fresh(r.id), floorId: fresh(r.floorId) })),
    links: space.links.map((l) => ({ ...l, from: fresh(l.from), to: fresh(l.to) })),
    eyeHeight: space.eyeHeight,
  };
}
