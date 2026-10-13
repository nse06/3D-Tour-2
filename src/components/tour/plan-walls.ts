import * as THREE from "three";
import type { TourSpace, Vec2 } from "@/lib/tour/types";

/** Per room, the stretches of its outline where the scanned model really has a wall (plan x, z). */
export type PlanWalls = Record<string, [Vec2, Vec2][]>;

const STEP = 0.15; // m between probes along an outline edge
const INSIDE = 0.4; // probes start this far inside the room…
const BEYOND = 0.35; // …and look this far past the outline for a wall
const HEIGHTS = [0.5, 1.6]; // above the floor: below a window's sill, and through a doorway
const MIN_WALL = 0.25; // shorter wall pieces are noise
const MAX_GAP = 0.3; // shorter gaps between wall pieces are noise (doorways are wider)

/**
 * Where each room's outline is a real wall in the scanned model, for the 3D floor plan. Room outlines
 * (RoomPlan footprints) run along open archways and, in merged multi-room scans, sometimes across a
 * neighbouring room, so drawing a wall on every edge invents walls. Instead, along each edge, short
 * rays from just inside the room look for the model's surface at the outline, at knee and head height:
 * a wall (even under a window) answers, a doorway or an open side doesn't.
 */
export function findPlanWalls(model: THREE.Object3D, space: TourSpace): PlanWalls {
  model.updateMatrixWorld(true);
  const elevation = new Map(space.floors.map((f) => [f.id, f.elevation]));
  const raycaster = new THREE.Raycaster();
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const out: PlanWalls = {};

  for (const room of space.rooms) {
    const poly = room.footprint;
    if (!poly || poly.length < 3) continue;
    const floorY = elevation.get(room.floorId) ?? 0;
    // Counter-clockwise in plan (x, z) when the signed area is positive: the inside is to the left.
    let twice = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) twice += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    const ccw = twice > 0;
    const walls: [Vec2, Vec2][] = [];

    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < MIN_WALL) return;
      const ux = (b[0] - a[0]) / len;
      const uz = (b[1] - a[1]) / len;
      // Inward normal: to the left of the edge on a counter-clockwise outline, to the right otherwise.
      const [nx, nz] = ccw ? [-uz, ux] : [uz, -ux];
      const n = Math.max(2, Math.round(len / STEP));
      const hits: boolean[] = [];
      for (let k = 0; k < n; k++) {
        const t = ((k + 0.5) / n) * len;
        const px = a[0] + ux * t;
        const pz = a[1] + uz * t;
        let hit = false;
        for (const h of HEIGHTS) {
          origin.set(px + nx * INSIDE, floorY + h, pz + nz * INSIDE);
          dir.set(-nx, 0, -nz);
          raycaster.set(origin, dir);
          raycaster.far = INSIDE + BEYOND;
          const found = raycaster.intersectObject(model, true).find((x) => (x.object as THREE.Mesh).isMesh && !x.object.userData.noPick);
          if (found && found.distance > INSIDE - BEYOND) {
            hit = true;
            break;
          }
        }
        hits.push(hit);
      }
      // Bridge tiny gaps, then keep runs of wall long enough to be real.
      for (let k = 0; k < n; ) {
        if (hits[k]) {
          k++;
          continue;
        }
        let end = k;
        while (end < n && !hits[end]) end++;
        if (k > 0 && end < n && (end - k) * (len / n) < MAX_GAP) for (let m = k; m < end; m++) hits[m] = true;
        k = end;
      }
      for (let k = 0; k < n; ) {
        if (!hits[k]) {
          k++;
          continue;
        }
        let end = k;
        while (end < n && hits[end]) end++;
        const t0 = (k / n) * len;
        const t1 = (end / n) * len;
        if (t1 - t0 >= MIN_WALL) {
          walls.push([
            [a[0] + ux * t0, a[1] + uz * t0],
            [a[0] + ux * t1, a[1] + uz * t1],
          ]);
        }
        k = end;
      }
    });
    out[room.id] = walls;
  }
  return out;
}
