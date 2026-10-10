"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { coverSourceAction, setCoverImageAction } from "@/app/dashboard/actions";
import type { LivePose, ViewerApi } from "@/components/tour/viewer-types";
import { walkthroughOrder } from "@/lib/tour/navigation";
import type { TourData, Waypoint } from "@/lib/tour/types";
import { dataUrlToBlob, uploadFile } from "@/lib/upload-client";

const TourScene = dynamic(() => import("@/components/tour/TourScene"), { ssr: false });

const FALLBACK_START: Waypoint = { position: [0, 1.6, 0], yaw: 0, pitch: 0 };
/** Cover photos: the cards (16:10), the tour's loading screen and link previews. */
const WIDTH = 1200;
const HEIGHT = 750;
/** How long a model may take to load before that listing is left for next time. */
const GIVE_UP_MS = 90_000;
const FAILED_KEY = "atrium.coverFailed";

function failedBefore(id: string): boolean {
  try {
    return (JSON.parse(sessionStorage.getItem(FAILED_KEY) ?? "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}

function rememberFailure(id: string) {
  try {
    const ids = JSON.parse(sessionStorage.getItem(FAILED_KEY) ?? "[]") as string[];
    sessionStorage.setItem(FAILED_KEY, JSON.stringify([...new Set([...ids, id])]));
  } catch {
    // Without session storage it just tries again next time.
  }
}

/**
 * Listings with a 3D tour but no cover photo get one: the walkthrough's opening view, rendered
 * offscreen once and saved as the cover, one listing at a time. The realtor can pick another view
 * (Rooms & viewpoints) or upload a photo instead.
 */
export function CoverMaker({ propertyIds }: { propertyIds: string[] }) {
  const router = useRouter();
  // Listings tried this visit (the list itself shrinks as covers arrive and the page refreshes).
  const [tried, setTried] = useState<string[]>([]);
  const [source, setSource] = useState<{ id: string; data: TourData; start: Waypoint } | null>(null);
  const apiRef = useRef<ViewerApi | null>(null);
  const poseRef = useRef<LivePose>({ position: FALLBACK_START.position, yaw: 0, floorId: null });
  const busy = useRef(false);
  const id = propertyIds.find((p) => !tried.includes(p));

  // The next listing's tour: what buyers see first.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const skip = () => !cancelled && setTried((t) => [...t, id]);
    if (failedBefore(id)) {
      skip();
      return;
    }
    coverSourceAction(id)
      .then((data) => {
        if (cancelled) return;
        if (!data) return skip();
        const start = walkthroughOrder(data.space)[0]?.waypoint ?? FALLBACK_START;
        setSource({ id, data, start });
      })
      .catch(skip);
    return () => {
      cancelled = true;
    };
  }, [id]);

  // A model that never loads is left for next time.
  useEffect(() => {
    if (!source) return;
    const timer = window.setTimeout(() => finish(source.id, false), GIVE_UP_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  function finish(doneId: string, ok: boolean) {
    if (!ok) rememberFailure(doneId);
    busy.current = false;
    apiRef.current = null; // the next listing's viewer hands over its own
    setSource((s) => (s?.id === doneId ? null : s));
    setTried((t) => (t.includes(doneId) ? t : [...t, doneId]));
    if (ok) router.refresh();
  }

  async function capture(current: { id: string; start: Waypoint }) {
    if (busy.current) return;
    busy.current = true;
    try {
      // The camera rig hands over its controls just after the model is in.
      for (let i = 0; i < 50 && !apiRef.current; i++) await new Promise((r) => setTimeout(r, 100));
      const api = apiRef.current;
      if (!api) throw new Error("viewer not ready");
      api.setPose(current.start, true);
      // A few frames for the camera to settle and the textures to reach the GPU.
      await new Promise((r) => setTimeout(r, 1200));
      const frame = api.captureFrame(WIDTH);
      if (!frame) throw new Error("no frame");
      const url = await uploadFile(current.id, "cover", dataUrlToBlob(frame), "cover.jpg");
      const res = await setCoverImageAction(current.id, url);
      if (!res.ok) throw new Error(res.error);
      finish(current.id, true);
    } catch {
      finish(current.id, false);
    }
  }

  if (!source) return null;
  const { data, start } = source;
  const noop = () => {};
  return (
    <div aria-hidden className="pointer-events-none fixed top-0 overflow-hidden" style={{ left: -10_000, width: WIDTH, height: HEIGHT }}>
      <TourScene
        key={source.id}
        assetUrl={data.assetUrl}
        cleanAssetUrl={data.cleanAssetUrl}
        photos={!(data.cleanAssetUrl && data.appearance === "studio")}
        appearance={data.appearance === "photoreal" ? "captured" : data.appearance}
        space={data.space}
        startWaypoint={start}
        apiRef={apiRef}
        poseRef={poseRef}
        active={false}
        mode="tour"
        onRoomChange={noop}
        onMovingChange={noop}
        onFade={noop}
        onProgress={noop}
        onLoaded={() => void capture(source)}
        onError={() => finish(source.id, false)}
      />
    </div>
  );
}
