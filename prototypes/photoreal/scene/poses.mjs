// Camera poses for the synthetic capture: where a realtor scanning the apartment would hold the
// phone (standing spots, looking around at three tilts; photos on the walk between rooms), and
// held-out eye-level views for comparing the results against the real thing.
export const FY = 362.5, W = 480, H = 360;

/** ARKit-style camera-to-world (column-major): turn about Y (yaw 0 = looking −Z, 90 = looking −X), then tilt. */
export function pose(x, y, z, yawDeg, pitchDeg) {
  const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const right = [cy, 0, -sy], up = [sy * sp, cp, cy * sp], back = [sy * cp, -sp, cy * cp];
  return [...right, 0, ...up, 0, ...back, 0, x, y, z, 1];
}

/** Yaw (degrees, our convention) that looks from (x, z) toward (tx, tz). */
export function yawTo(x, z, tx, tz) {
  return (Math.atan2(-(tx - x), -(tz - z)) * 180) / Math.PI;
}

// Standing spots per room (open floor), and the walk between them.
const spots = [
  [0, 1.2, 1.2], [0, 3.6, 1.3], [0, 4.4, 2.8], [0, 1.65, 3.15],
  [1, 6.4, 0.7], [1, 7.15, 1.0], [1, 7.0, 3.5], [1, 5.6, 3.6],
  [2, 4.0, 4.95], [2, 5.9, 5.15], [2, 7.4, 4.9],
  [3, 2.5, 5.1], [3, 2.5, 6.6], [3, 1.0, 7.6],
  [4, 4.05, 6.4], [4, 4.0, 7.3],
  [5, 6.3, 6.0], [5, 7.35, 6.05],
];
const walk = [[1.2, 1.2], [3.6, 1.3], [4.4, 2.8], [5.06, 2.0], [6.4, 0.7], [7.15, 1.0], [7.0, 3.5], [5.6, 3.6], [5.06, 2.4], [4.2, 3.1], [4.0, 3.95],
  [4.0, 4.95], [3.4, 4.92], [2.94, 4.92], [2.5, 5.1], [2.5, 6.6], [2.5, 5.1], [2.94, 4.92], [4.0, 4.95], [4.2, 5.58], [4.05, 6.4], [4.0, 7.3],
  [4.05, 6.4], [4.2, 5.58], [5.9, 5.15], [6.8, 5.58], [6.3, 6.0], [7.35, 6.05], [6.8, 5.58], [7.4, 4.9]];

function jitter(k) {
  const s = Math.sin(k * 12.9898) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

export function capturePoses() {
  const out = [];
  spots.forEach(([room, x, z], i) => {
    for (const [row, pitch] of [[0, -40], [1, -12], [2, 15]].map((p) => p)) {
      for (let k = 0; k < 12; k++) {
        const n = out.length;
        const yaw = k * 30 + (row * 10) + jitter(n) * 6;
        const y = 1.38 + jitter(n + 7) * 0.08;
        out.push({ room, spot: i, m: pose(x + jitter(n + 3) * 0.08, y, z + jitter(n + 5) * 0.08, yaw, pitch + jitter(n + 9) * 4) });
      }
    }
  });
  // On the walk: a photo every ~0.7 m, looking ahead (slightly down).
  for (let k = 0; k + 1 < walk.length; k++) {
    const [ax, az] = walk[k], [bx, bz] = walk[k + 1];
    const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.round(len / 0.7));
    const yaw = yawTo(ax, az, bx, bz);
    for (let s = 1; s < steps; s++) {
      const f = s / steps, n = out.length;
      out.push({ room: -1, spot: -1, m: pose(ax + (bx - ax) * f, 1.4, az + (bz - az) * f, yaw + jitter(n) * 20, -10 + jitter(n + 1) * 6) });
    }
  }
  return out;
}

/** Held-out views at eye height (1.55 m), each looking at something worth comparing. */
export function testPoses() {
  const v = (name, x, z, tx, tz, pitch, y = 1.55) => ({ name, m: pose(x, y, z, yawTo(x, z, tx, tz), pitch) });
  return [
    v("Living room: sofa and rug", 1.0, 0.8, 3.2, 3.6, -16),
    v("Living room from the hallway door", 4.2, 3.0, 0.5, 1.5, -10),
    v("Living room: TV wall and window", 2.0, 3.0, 2.6, 0.0, -8),
    v("Living room seen from the kitchen", 5.06, 2.0, 1.5, 2.6, -10),
    v("Kitchen: table and cabinets", 5.5, 0.5, 7.4, 2.6, -18),
    v("Kitchen: counter and fridge", 6.9, 0.35, 7.6, 3.6, -14),
    v("Kitchen: glossy floor", 5.45, 3.0, 7.5, 1.0, -30),
    v("Hallway mirror", 4.9, 5.25, 6.2, 4.33, -6),
    v("Hallway toward the front door", 3.4, 4.95, 8.2, 4.95, -8),
    v("Bedroom", 2.55, 5.3, 0.3, 7.0, -18),
    v("Bathroom mirror", 4.25, 6.95, 3.0, 6.1, -10),
    v("Primary bedroom", 6.9, 5.95, 6.9, 8.6, -16),
  ];
}
