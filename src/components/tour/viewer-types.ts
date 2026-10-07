import type { Vec3, Waypoint } from "@/lib/tour/types";

/** Imperative handle the overlay UI uses to drive the 3D camera. */
export interface ViewerApi {
  goToRoom: (roomId: string) => void;
  getPose: () => Waypoint;
  /** Teleport/glide to an arbitrary pose (used by the room editor). */
  setPose: (pose: Waypoint, instant?: boolean) => void;
  /** Grab the current frame as a JPEG data URL (cover photos). */
  captureFrame: (width?: number) => string | null;
  /** True when nothing in the model blocks the straight line between two points. */
  lineOfSight: (a: Vec3, b: Vec3) => boolean;
  /** Drop the camera to eye height above the floor beneath it. Returns false if no floor was found. */
  snapToFloor: () => boolean;
}

/** Live camera pose shared with DOM overlays (floor plan) without re-rendering React. */
export interface LivePose {
  position: Vec3;
  yaw: number;
  floorId: string | null;
}

export type ViewerMode = "tour" | "edit";
