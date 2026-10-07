import type { CaptureSource, NavLink, TourAppearance, TourFloor, TourRoom, TourSpace } from "@/lib/tour/types";

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
 * `assetUrl` is whatever the viewer should load: the bundled demo .glb, an
 * uploaded .glb/.gltf, or the model the Atrium Capture iPhone app built from a
 * RoomPlan scan. For iPhone scans `scanPackageUrl` points at the raw scan
 * package (RoomPlan data, ARKit trajectory, RGB keyframes) so it can be
 * reprocessed later; `processingStatus` is reserved for server-side
 * processing. The viewer is unchanged either way.
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
  appearance: TourAppearance;
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
  /** Raw scan package (.zip) of an iPhone capture, kept for reprocessing. */
  scanPackageUrl?: string | null;
  /** Spatial structure from the capture's manifest; null when the realtor will define rooms manually. */
  space: TourSpace | null;
  /** Default look; photo-textured scans ask for "captured". Defaults to "studio". */
  appearance?: TourAppearance;
}

/**
 * Pairs the Atrium Capture iPhone app with one listing. The phone holds a
 * random token (shown as a QR code / deep link); only its SHA-256 is stored.
 * A session can be used for several uploads until it expires.
 */
export interface CaptureSession {
  id: string;
  propertyId: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  /** When the last scan was received with this session. */
  completedAt: string | null;
}

export interface CaptureSessionLookup {
  session: CaptureSession;
  property: Pick<Property, "id" | "addressLine" | "city" | "state">;
}

export interface AppUser {
  id: string;
  email: string | null;
  name: string;
}
