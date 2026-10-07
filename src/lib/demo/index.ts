// The bundled demo capture: "1234 Sheridan Road, Wilmette, IL".
//
// The .glb and manifest are produced by scripts/generate-demo-property.mjs.
// In the dashboard a realtor can attach this capture to any property, which
// exercises exactly the same code path a real iPhone scan will use.

import { isScanManifest, manifestToSpace, type ScanManifest } from "@/lib/tour/scan-manifest";
import type { TourData } from "@/lib/tour/types";
import manifestJson from "./sheridan-road.manifest.json";
import { DEMO_LISTING } from "./listing";

export { DEMO_LISTING };

export const DEMO_ASSET_URL = "/demo/sheridan-road.glb";
export const DEMO_COVER_URL = "/demo/sheridan-road-cover.jpg";
export const SAMPLE_SLUG = "sample";

export function demoManifest(): ScanManifest {
  if (!isScanManifest(manifestJson)) throw new Error("Demo manifest is invalid");
  return manifestJson;
}

/** The public sample tour at /tour/sample (always available, no database needed). */
export function sampleTour(): TourData {
  return {
    property: {
      slug: SAMPLE_SLUG,
      ...DEMO_LISTING,
      coverImageUrl: DEMO_COVER_URL,
    },
    assetUrl: DEMO_ASSET_URL,
    source: "demo",
    appearance: "studio",
    space: manifestToSpace(demoManifest(), (kind, key) => `${kind}-${key}`),
  };
}
