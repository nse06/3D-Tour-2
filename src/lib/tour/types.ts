// Core spatial model shared by the viewer, the dashboard and the data layer.
//
//   Property → Tour → Floors → Rooms → Waypoints (+ walkable links)
//
// A Tour is "a 3D asset + the spatial structure needed to walk through it".
// The viewer never cares where the asset came from: the bundled demo, a
// manually uploaded .glb, or (eventually) a processed iPhone LiDAR scan.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** A camera pose. yaw/pitch in radians; yaw=0 looks toward -z, +yaw turns left. */
export interface Waypoint {
  position: Vec3;
  yaw: number;
  pitch: number;
}

export interface FloorFeature {
  type: "stairs" | "void";
  polygon: Vec2[];
  label?: string;
  direction?: "up" | "down";
  treads?: number;
}

export interface TourFloor {
  id: string;
  name: string;
  /** 1 = main level, 2 = upper level, 0/-1 = lower levels. */
  level: number;
  /** Height of the walkable floor surface in model units (meters). */
  elevation: number;
  /** Exterior outline in plan (x, z), used to draw the floor plan. */
  outline: Vec2[] | null;
  features: FloorFeature[];
}

export interface TourRoom {
  id: string;
  floorId: string;
  name: string;
  order: number;
  waypoint: Waypoint;
  /** Room polygon in plan (x, z). From RoomPlan in the future. */
  footprint: Vec2[] | null;
}

/** A walkable connection between two rooms through doorways / stairs. */
export interface NavLink {
  from: string;
  to: string;
  /** Intermediate points (doorway centers, stair landings) at eye height. */
  via: Vec3[];
  kind?: "door" | "stairs";
}

export interface TourSpace {
  floors: TourFloor[];
  rooms: TourRoom[];
  links: NavLink[];
  eyeHeight: number;
}

export type CaptureSource = "demo" | "upload" | "ios_scan";

export interface PropertyInfo {
  slug: string;
  title: string;
  addressLine: string;
  city: string;
  state: string;
  postalCode: string;
  price: number;
  bedrooms: number;
  bathrooms: number;
  squareFeet: number;
  description: string;
  coverImageUrl: string | null;
}

/** Everything the public viewer needs to render a tour. */
export interface TourData {
  property: PropertyInfo;
  assetUrl: string;
  source: CaptureSource;
  space: TourSpace;
}
