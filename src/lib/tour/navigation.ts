// Navigation over the tour's spatial graph.
//
// Rooms are graph nodes (their waypoints), links are edges whose `via`
// points thread the camera through doorways and up staircases. Arbitrary
// free movement can later be layered on top (e.g. a navmesh from the scan);
// the viewer only asks this module for "a path from here to there".

import type { NavLink, TourFloor, TourRoom, TourSpace, Vec2, Vec3 } from "./types";

export function sortedFloors(space: TourSpace): TourFloor[] {
  return [...space.floors].sort((a, b) => a.level - b.level);
}

/** Rooms in walkthrough order (floor by floor, then by room order). */
export function walkthroughOrder(space: TourSpace): TourRoom[] {
  const floorRank = new Map(sortedFloors(space).map((f, i) => [f.id, i]));
  return [...space.rooms].sort(
    (a, b) => (floorRank.get(a.floorId) ?? 0) - (floorRank.get(b.floorId) ?? 0) || a.order - b.order,
  );
}

export function pointInPolygon(x: number, z: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Which floor is the camera on, given its height? */
export function floorForHeight(space: TourSpace, y: number): TourFloor | null {
  const floors = sortedFloors(space);
  if (!floors.length) return null;
  const feet = y - space.eyeHeight;
  let best = floors[0];
  for (const f of floors) if (feet >= f.elevation - 0.6) best = f;
  return best;
}

export function roomAt(space: TourSpace, pos: Vec3): TourRoom | null {
  const floor = floorForHeight(space, pos[1]);
  if (!floor) return null;
  const candidates = space.rooms.filter((r) => r.floorId === floor.id);
  for (const r of candidates) {
    if (r.footprint && r.footprint.length >= 3 && pointInPolygon(pos[0], pos[2], r.footprint)) return r;
  }
  return null;
}

/** Nearest room (by waypoint distance) on the camera's floor; fallback when no footprints exist. */
export function nearestRoom(space: TourSpace, pos: Vec3): TourRoom | null {
  const floor = floorForHeight(space, pos[1]);
  let best: TourRoom | null = null;
  let bestD = Infinity;
  for (const r of space.rooms) {
    if (floor && r.floorId !== floor.id) continue;
    const d = dist(r.waypoint.position, pos);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function polylineLength(points: Vec3[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1], points[i]);
  return l;
}

interface Edge {
  to: string;
  via: Vec3[];
  cost: number;
  kind?: NavLink["kind"];
}

/**
 * Shortest walkable route between two rooms. Returns the sequence of points
 * (excluding the start position) or null when the rooms are not connected.
 */
export function findRoute(space: TourSpace, fromRoomId: string, toRoomId: string): { points: Vec3[]; usesStairs: boolean } | null {
  if (fromRoomId === toRoomId) return { points: [], usesStairs: false };
  const rooms = new Map(space.rooms.map((r) => [r.id, r]));
  const graph = new Map<string, Edge[]>();
  const add = (a: string, b: string, via: Vec3[], kind?: NavLink["kind"]) => {
    const ra = rooms.get(a);
    const rb = rooms.get(b);
    if (!ra || !rb) return;
    const cost = polylineLength([ra.waypoint.position, ...via, rb.waypoint.position]);
    if (!graph.has(a)) graph.set(a, []);
    graph.get(a)!.push({ to: b, via, cost, kind });
  };
  for (const l of space.links) {
    add(l.from, l.to, l.via, l.kind);
    add(l.to, l.from, [...l.via].reverse(), l.kind);
  }

  // Dijkstra (graphs are tiny).
  const distTo = new Map<string, number>([[fromRoomId, 0]]);
  const prev = new Map<string, { from: string; edge: Edge }>();
  const open = new Set<string>([fromRoomId]);
  while (open.size) {
    let cur = "";
    let best = Infinity;
    for (const id of open) {
      const d = distTo.get(id) ?? Infinity;
      if (d < best) {
        best = d;
        cur = id;
      }
    }
    open.delete(cur);
    if (cur === toRoomId) break;
    for (const e of graph.get(cur) ?? []) {
      const nd = best + e.cost;
      if (nd < (distTo.get(e.to) ?? Infinity)) {
        distTo.set(e.to, nd);
        prev.set(e.to, { from: cur, edge: e });
        open.add(e.to);
      }
    }
  }
  if (!prev.has(toRoomId)) return null;

  const edges: Edge[] = [];
  let node = toRoomId;
  while (node !== fromRoomId) {
    const p = prev.get(node)!;
    edges.unshift(p.edge);
    node = p.from;
  }
  // Rooms are convex in practice, so we can walk doorway-to-doorway without
  // detouring through intermediate waypoints.
  const points: Vec3[] = [];
  for (const e of edges) points.push(...e.via);
  points.push(rooms.get(toRoomId)!.waypoint.position);
  return { points, usesStairs: edges.some((e) => e.kind === "stairs") };
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const [px, pz] of poly) {
    x += px;
    z += pz;
  }
  return [x / poly.length, z / poly.length];
}
