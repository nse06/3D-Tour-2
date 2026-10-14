// The remaster's steps (worker/remaster/atrium_remaster/job.py), in the order the GPU runs them: what
// the listing page says during each, and roughly what share of a job's time each takes (a home of a
// few rooms scanned with its layout, on an A10G). The worker reports how far along the step it's on
// is; the site keeps how far along the whole job is, so the bar fills once, from start to finish. A
// step a job skips (no layout, so no furniture) is jumped over.

export const REMASTER_STEPS = [
  { stage: "starting", label: "Starting the GPU", share: 6 },
  { stage: "downloading", label: "The GPU is downloading the photos and the model", share: 6 },
  { stage: "cleanup", label: "Sharpening the blurry photos", share: 4 },
  { stage: "shapes", label: "Adding trim: doors and windows, baseboards, casings", share: 2 },
  { stage: "furniture", label: "Making the furniture's shapes from the photos", share: 20 },
  { stage: "depth", label: "Measuring depth in the photos", share: 18 },
  { stage: "skins", label: "Learning the skins from every photo", share: 29 },
  { stage: "fill", label: "Filling in spots no photo saw", share: 4 },
  { stage: "light", label: "Evening out the lighting", share: 1 },
  { stage: "spots", label: "Making the photo spots", share: 7 },
  { stage: "uploading", label: "Saving the remastered model", share: 3 },
] as const;

const TOTAL = REMASTER_STEPS.reduce((sum, s) => sum + s.share, 0);

/** What the listing page says during a step; null for a step it doesn't know. */
export function stepLabel(stage: string | null | undefined): string | null {
  return REMASTER_STEPS.find((s) => s.stage === stage)?.label ?? null;
}

/**
 * How far along a whole job is (0–1), from the step it's on and how far along that step is (0–1):
 * the steps before it, and as much of this one's share. Null for a step the site doesn't know.
 */
export function jobProgress(stage: string | null | undefined, step: number): number | null {
  const done = Number.isFinite(step) ? Math.max(0, Math.min(1, step)) : 0;
  let before = 0;
  for (const s of REMASTER_STEPS) {
    if (s.stage === stage) return (before + s.share * done) / TOTAL;
    before += s.share;
  }
  return null;
}
