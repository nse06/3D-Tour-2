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
  /** Photo-textured iPhone scans: a clean model of the same rooms (the viewer's "photos off" view). */
  cleanAssetUrl: string | null;
  /** Photoreal splats (.spz) trained on the capture's photos (docs/photoreal.md). */
  splatUrl: string | null;
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
  /** A clean model of the same rooms, for the viewer's "photos off" view. */
  cleanAssetUrl?: string | null;
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

export type PhotorealStatus = "uploading" | "queued" | "running" | "done" | "failed";

/**
 * One photoreal training run (docs/photoreal.md): the phone uploads the scan's photos, the GPU
 * worker trains splats on them and reports back. `files`/`bytes`: what the phone said it uploads.
 */
export interface PhotorealJob {
  id: string;
  propertyId: string;
  tourId: string | null;
  userId: string;
  status: PhotorealStatus;
  /** What the worker is doing ("downloading", "training", "uploading") and how far along (0–1). */
  stage: string | null;
  progress: number;
  message: string | null;
  files: number;
  bytes: number;
  splatUrl: string | null;
  stats: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type PhotorealJobUpdate = Partial<Pick<PhotorealJob, "status" | "stage" | "progress" | "message" | "splatUrl" | "stats" | "startedAt" | "finishedAt">>;

export interface AppUser {
  id: string;
  email: string | null;
  name: string;
}
