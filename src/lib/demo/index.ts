// The bundled demo capture: "1234 Sheridan Road, Wilmette, IL".
//
// The .glb and manifest are produced by scripts/generate-demo-property.mjs.
// In the dashboard a realtor can attach this capture to any property, which
// exercises exactly the same code path a real iPhone scan will use.

import { isScanManifest, manifestToSpace, type ScanManifest } from "@/lib/tour/scan-manifest";
import type { TourData } from "@/lib/tour/types";
import manifestJson from "./sheridan-road.manifest.json";

export const DEMO_ASSET_URL = "/demo/sheridan-road.glb";
export const DEMO_COVER_URL = "/demo/sheridan-road-cover.jpg";
export const SAMPLE_SLUG = "sample";

export const DEMO_LISTING = {
  title: "Lakeside Georgian on Sheridan Road",
  addressLine: "1234 Sheridan Road",
  city: "Wilmette",
  state: "IL",
  postalCode: "60091",
  price: 2495000,
  bedrooms: 5,
  bathrooms: 4.5,
  squareFeet: 4200,
  description:
    "Set on a quiet stretch of Sheridan Road moments from the lakefront, this light-filled North Shore residence pairs classic proportions with an easy, modern plan. A double-height foyer opens to a fireplace living room, a formal dining room and a chef's kitchen with a marble waterfall island and sunny breakfast nook. A green-paneled library office sits just off the entry.\n\nUpstairs, the primary suite offers a sitting area overlooking the gardens and a spa bath with a freestanding tub and walk-in shower, joined by two additional bedrooms. The finished lower level adds two more bedrooms and a recreation room.",
};

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
    space: manifestToSpace(demoManifest(), (kind, key) => `${kind}-${key}`),
  };
}
