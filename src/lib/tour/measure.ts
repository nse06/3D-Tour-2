// Room sizes and distances for the viewer's floor plan and measuring tool.
//
// Rooms come from the scan in meters (RoomPlan floor polygons, docs/iphone-capture.md). LiDAR scans
// are typically good to a few centimeters on a room but can drift a few percent along long walls, so
// everything shown from here is labelled approximate.

import type { Vec2, Vec3 } from "./types";

const FEET_PER_METER = 3.280839895;
const SQ_FEET_PER_SQ_METER = FEET_PER_METER * FEET_PER_METER;
/** A room counts as rectangular (and gets "length × width") when it fills this much of its best rectangle. */
const RECTANGULAR = 0.9;

/** Area of a simple polygon in plan (m²). */
export function polygonArea(poly: Vec2[]): number {
  let twice = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) twice += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(twice) / 2;
}

function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Vec2[]) => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

export interface RoomSize {
  /** Floor area (m²). */
  area: number;
  /** The smallest rectangle around the room, along its own walls (m). */
  length: number;
  width: number;
  /** True when the room is close enough to that rectangle for "length × width" to describe it. */
  rectangular: boolean;
}

/** A room's size from its floor polygon (meters, in plan). Null for degenerate polygons. */
export function roomSize(poly: Vec2[] | null | undefined): RoomSize | null {
  if (!poly || poly.length < 3) return null;
  const area = polygonArea(poly);
  const hull = convexHull(poly);
  if (hull.length < 3 || area <= 0) return null;
  // The minimum-area enclosing rectangle has a side along one of the hull's edges.
  let best = { area: Infinity, a: 0, b: 0 };
  for (let i = 0; i < hull.length; i++) {
    const [x0, z0] = hull[i];
    const [x1, z1] = hull[(i + 1) % hull.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const a = maxU - minU;
    const b = maxV - minV;
    if (a * b < best.area) best = { area: a * b, a, b };
  }
  if (!Number.isFinite(best.area) || best.area <= 0) return null;
  return {
    area,
    length: Math.max(best.a, best.b),
    width: Math.min(best.a, best.b),
    rectangular: area / best.area >= RECTANGULAR,
  };
}

/** Straight-line distance between two points (m). */
export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 4.32 m → 14′ 2″ (to the nearest inch). */
export function formatFeetInches(meters: number): string {
  const inches = Math.round(meters * FEET_PER_METER * 12);
  const feet = Math.floor(inches / 12);
  const rest = inches % 12;
  if (feet === 0) return `${rest}″`;
  return `${feet}′ ${rest}″`;
}

/** 4.32 m → "4.32 m"; under a meter in centimeters. */
export function formatMeters(meters: number): string {
  return meters < 1 ? `${Math.round(meters * 100)} cm` : `${meters.toFixed(2)} m`;
}

/** m² → "182 sq ft" (to the nearest square foot; the nearest 10 above 1,000). */
export function formatSquareFeet(squareMeters: number): string {
  const sqft = squareMeters * SQ_FEET_PER_SQ_METER;
  const rounded = sqft >= 1000 ? Math.round(sqft / 10) * 10 : Math.round(sqft);
  return `${rounded.toLocaleString("en-US")} sq ft`;
}

/** A room's size as shown on the floor plan: "14′ 2″ × 11′ 8″", or its area when it isn't a rectangle. */
export function formatRoomSize(size: RoomSize): string {
  return size.rectangular ? `${formatFeetInches(size.length)} × ${formatFeetInches(size.width)}` : formatSquareFeet(size.area);
}
