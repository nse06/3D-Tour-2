// The "scan manifest" is the spatial half of a capture package.
//
// Today it is produced by scripts/generate-demo-property.mjs and embedded in
// the demo .glb (scene extras → `atrium`). Tomorrow the iPhone capture app
// will produce the same structure from RoomPlan (room polygons, floors) and
// the ARKit camera trajectory (waypoints, walkable links). Any uploaded .glb
// that carries a manifest gets its floors/rooms/waypoints created
// automatically — no manual setup for the realtor.

import type { NavLink, TourFloor, TourRoom, TourSpace, Vec2, Vec3, Waypoint } from "./types";

export const SCAN_MANIFEST_SCHEMA = "atrium.scan-manifest/v1";

export interface ScanManifest {
  schema: typeof SCAN_MANIFEST_SCHEMA;
  source?: { kind: string; generator?: string; note?: string };
  units: "meters";
  upAxis: "y";
  eyeHeight: number;
  floors: {
    key: string;
    name: string;
    level: number;
    elevation: number;
    outline?: Vec2[];
    features?: TourFloor["features"];
  }[];
  rooms: {
    key: string;
    name: string;
    floor: string;
    order: number;
    footprint?: Vec2[];
    waypoint: Waypoint;
  }[];
  links: { from: string; to: string; via: Vec3[]; kind?: "door" | "stairs" }[];
  /** How the model should be shown by default: "captured" for photo-textured scans (lighting baked into the photos). */
  appearance?: "studio" | "captured";
}

export function isScanManifest(value: unknown): value is ScanManifest {
  const v = value as ScanManifest | null;
  return !!v && v.schema === SCAN_MANIFEST_SCHEMA && Array.isArray(v.floors) && Array.isArray(v.rooms);
}

/**
 * Convert a manifest into a TourSpace. `makeId` lets the caller decide how ids
 * are generated (stable keys for the bundled demo, UUIDs when persisting).
 */
export function manifestToSpace(manifest: ScanManifest, makeId: (kind: "floor" | "room", key: string) => string): TourSpace {
  const floorIds = new Map<string, string>();
  const floors: TourFloor[] = manifest.floors.map((f) => {
    const id = makeId("floor", f.key);
    floorIds.set(f.key, id);
    return {
      id,
      name: f.name,
      level: f.level,
      elevation: f.elevation,
      outline: f.outline ?? null,
      features: f.features ?? [],
    };
  });
  const roomIds = new Map<string, string>();
  const rooms: TourRoom[] = manifest.rooms
    .filter((r) => floorIds.has(r.floor))
    .map((r) => {
      const id = makeId("room", r.key);
      roomIds.set(r.key, id);
      return {
        id,
        floorId: floorIds.get(r.floor)!,
        name: r.name,
        order: r.order,
        waypoint: r.waypoint,
        footprint: r.footprint ?? null,
      };
    });
  const links: NavLink[] = manifest.links
    .filter((l) => roomIds.has(l.from) && roomIds.has(l.to))
    .map((l) => ({ from: roomIds.get(l.from)!, to: roomIds.get(l.to)!, via: l.via, kind: l.kind }));
  return { floors, rooms, links, eyeHeight: manifest.eyeHeight ?? 1.6 };
}

/**
 * Read the embedded manifest from a .glb without parsing geometry: only the
 * 12-byte header and the JSON chunk are touched, so this is cheap even for
 * large captures. Works in the browser (File/Blob) and in Node (Buffer).
 */
export async function readManifestFromGlb(blob: Blob): Promise<ScanManifest | null> {
  const header = new DataView(await blob.slice(0, 20).arrayBuffer());
  if (header.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
  const jsonLength = header.getUint32(12, true);
  const chunkType = header.getUint32(16, true);
  if (chunkType !== 0x4e4f534a) return null; // 'JSON'
  const text = await blob.slice(20, 20 + jsonLength).text();
  return findManifestInGltfJson(text);
}

export function findManifestInGltfJson(text: string): ScanManifest | null {
  try {
    const json = JSON.parse(text);
    const candidates = [
      json?.extras?.atrium,
      json?.asset?.extras?.atrium,
      ...(Array.isArray(json?.scenes) ? json.scenes.map((s: { extras?: { atrium?: unknown } }) => s?.extras?.atrium) : []),
    ];
    return (candidates.find(isScanManifest) as ScanManifest | undefined) ?? null;
  } catch {
    return null;
  }
}
