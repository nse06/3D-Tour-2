import type { CaptureSource, NavLink, TourFloor, TourRoom, TourSpace } from "@/lib/tour/types";

export interface Property {
  id: string;
  userId: string;
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
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PropertyInput = Pick<
  Property,
  "title" | "addressLine" | "city" | "state" | "postalCode" | "price" | "bedrooms" | "bathrooms" | "squareFeet" | "description"
>;

/**
 * A Tour is one 3D capture of a property plus its spatial structure.
 *
 * `assetUrl` is whatever the viewer should load. Today that is the bundled
 * demo .glb or an uploaded .glb/.gltf. When the iPhone capture app ships,
 * `scanPackageUrl` will point at the raw upload (RoomPlan rooms, ARKit
 * trajectory, RGB frames) and `processingStatus` will track the backend job
 * that turns it into `assetUrl` + floors/rooms/links. The viewer is unchanged.
 */
export interface Tour {
  id: string;
  propertyId: string;
  assetUrl: string;
  assetFormat: "glb" | "gltf";
  source: CaptureSource;
  scanPackageUrl: string | null;
  processingStatus: "ready" | "processing" | "failed";
  navigation: { links: NavLink[]; eyeHeight: number };
  published: boolean;
  createdAt: string;
}

export interface FloorRecord extends TourFloor {
  tourId: string;
}

export type RoomRecord = TourRoom;

export interface PropertyBundle {
  property: Property;
  tour: Tour | null;
  space: TourSpace | null;
}

export interface PropertySummary {
  property: Property;
  tour: Pick<Tour, "id" | "source" | "processingStatus" | "published"> | null;
  roomCount: number;
  floorCount: number;
}

export interface CaptureInput {
  assetUrl: string;
  assetFormat: "glb" | "gltf";
  source: CaptureSource;
  /** Spatial structure from the capture's manifest; null when the realtor will define rooms manually. */
  space: TourSpace | null;
}

export interface AppUser {
  id: string;
  email: string | null;
  name: string;
}
