"use client";

import { AlertTriangle, CheckCircle2, Eye, Loader2, Play, RefreshCw, RotateCcw, WandSparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { setAppearanceAction, startRemasterAction } from "@/app/dashboard/actions";
import { Button, ButtonLink } from "@/components/ui";
import type { RemasterSummary } from "@/lib/remaster";

const POLL_MS = 5000;
const STAGE: Record<string, string> = {
  starting: "Starting the GPU",
  downloading: "The GPU is downloading the photos and the model",
  cleanup: "Sharpening the blurry photos",
  shapes: "Adding trim: doors and windows, baseboards, casings",
  furniture: "Making the furniture's shapes from the photos",
  depth: "Measuring depth in the photos",
  skins: "Learning the skins from every photo",
  fill: "Filling in spots no photo saw",
  spots: "Making the photo spots",
  uploading: "Saving the remastered model",
};

/** What the remaster changed beyond the skins, from its stats (worker/remaster), for the realtor to know. */
function aiChanges(stats: Record<string, unknown>): string[] {
  const count = (key: string, one: string, many: string) => {
    const n = stats[key];
    return typeof n === "number" && n > 0 ? `${n} ${n === 1 ? one : many}` : null;
  };
  return [
    count("furnitureMade", "piece of furniture reshaped", "pieces of furniture reshaped"),
    count("fused", "scanned shape sharpened", "scanned shapes sharpened"),
    count("recessed", "door or window set into its wall", "doors and windows set into their walls"),
    count("baseboards", "baseboard", "baseboards"),
    count("crowns", "crown molding", "crown moldings"),
    count("casings", "door or window casing", "door and window casings"),
    count("cabinetGaps", "cabinet door gap", "cabinet door gaps"),
    count("tvsOff", "TV shown off", "TVs shown off"),
    count("windowsBrightened", "dark window brightened", "dark windows brightened"),
    count("photosSharpened", "blurry photo sharpened", "blurry photos sharpened"),
  ].filter((s): s is string => s !== null);
}

/**
 * The listing's remastered model (docs/remaster.md): a cloud GPU rebuilds the painted model from the
 * scan's photos kept on the server. Separate from photoreal; once it's ready, the realtor chooses
 * whether buyers see it instead of the painted model.
 */
export function RemasterPanel({
  propertyId,
  initialJob,
  gpuReady,
  photosReady,
  hasRemaster,
  buyersSeeRemaster,
}: {
  propertyId: string;
  initialJob: RemasterSummary | null;
  gpuReady: boolean;
  /** The scan's photos are on the server (a photoreal upload left them). */
  photosReady: boolean;
  /** The listing's scan has a remastered model. */
  hasRemaster: boolean;
  /** Buyers start with the remastered model. */
  buyersSeeRemaster: boolean;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const moving = job?.status === "running";

  useEffect(() => {
    if (!moving) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const res = await fetch(`/api/properties/${propertyId}/remaster`, { cache: "no-store" }).catch(() => null);
      if (stopped || !res?.ok) return;
      const next = (await res.json()).job as RemasterSummary | null;
      if (!next) return;
      setJob((previous) => {
        if (next.status !== "running" && previous?.status === "running") router.refresh();
        return next;
      });
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [moving, propertyId, router]);

  const start = () =>
    startTransition(async () => {
      setError(null);
      const res = await startRemasterAction(propertyId);
      if (res.checkoutUrl) {
        setLeaving(true);
        window.location.assign(res.checkoutUrl);
        return;
      }
      if (!res.ok) setError(res.error ?? "The GPU didn't take the job.");
      const latest = await fetch(`/api/properties/${propertyId}/remaster`, { cache: "no-store" }).catch(() => null);
      if (latest?.ok) setJob((await latest.json()).job);
      router.refresh();
    });
  const choose = (remastered: boolean) =>
    startTransition(async () => {
      setError(null);
      const res = await setAppearanceAction(propertyId, remastered ? "remastered" : "captured");
      if (!res.ok) setError(res.error ?? "That couldn't be changed.");
      router.refresh();
    });

  const busy = pending || leaving;
  const stats = job?.stats ?? {};
  const minutes = job?.startedAt && job.finishedAt ? Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60000) : null;
  const startButton = (label: string, icon: "play" | "again" | "retry") =>
    gpuReady && photosReady ? (
      <Button onClick={start} disabled={busy} size="sm" variant={icon === "play" ? "primary" : "secondary"}>
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : icon === "play" ? (
          <Play className="size-3.5" />
        ) : icon === "again" ? (
          <RefreshCw className="size-3.5" />
        ) : (
          <RotateCcw className="size-3.5" />
        )}{" "}
        {label}
      </Button>
    ) : null;
  const needsPhotos = !photosReady && (
    <p className="text-xs text-neutral-500">
      It works from the scan&apos;s photos on the server. In <b className="font-semibold">Atrium Capture</b>, open this scan and tap{" "}
      <b className="font-semibold">Make it photoreal</b>: that sends them, and the remaster starts by itself.
    </p>
  );

  return (
    <div>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">
        <WandSparkles className="size-3.5" /> Remastered model <span className="rounded-full bg-linen px-2 py-0.5 text-[10px] tracking-[0.1em]">Beta</span>
      </p>

      {(!job || (job.status === "queued" && !job.startedAt && !job.message)) && (
        <div className="mt-3 space-y-3 text-sm text-neutral-600">
          <p>
            A cloud GPU rebuilds this 3D model from all of the scan&apos;s photos at once: sharper walls and floors, even colors, and spots no photo saw filled
            in. About 20 minutes; buyers keep seeing what they see now until you choose the remastered model.
          </p>
          {needsPhotos}
          {!gpuReady && <p className="text-xs text-neutral-400">The remaster GPU isn&apos;t connected to this site yet (see docs/remaster.md).</p>}
          {startButton("Remaster with AI", "play")}
        </div>
      )}

      {job?.status === "queued" && (job.startedAt || job.message) && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-neutral-600">Waiting for the GPU.</p>
          {job.message && <p className="text-xs text-neutral-400">{job.message}</p>}
          {startButton("Start", "play")}
        </div>
      )}

      {job?.status === "running" && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="flex items-center gap-2 text-neutral-700">
            <Loader2 className="size-4 animate-spin" /> {STAGE[job.stage ?? ""] ?? "Working"}
            {job.stage === "skins" && ` — ${Math.round(job.progress * 100)}%`}
          </p>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-linen"
            role="progressbar"
            aria-valuenow={Math.round(job.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${Math.max(3, job.progress * 100)}%` }} />
          </div>
          {job.message && <p className="text-xs text-neutral-400">{job.message}</p>}
        </div>
      )}

      {job?.status === "done" && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="flex items-start gap-2 text-neutral-700">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            <span>Ready. Compare it with the painted model in the walkthrough (the switch at the bottom), then pick what buyers see.</span>
          </p>
          {job.message && <p className="text-xs text-amber-700">{job.message}</p>}
          {aiChanges(stats).length > 0 && <p className="text-xs text-neutral-500">What the AI changed: {aiChanges(stats).join(", ")}.</p>}
          <p className="text-xs text-neutral-400">
            {[
              typeof stats.photos === "number" ? `${stats.photos} photos` : null,
              typeof stats.modelMB === "number" ? `${stats.modelMB} MB` : null,
              minutes != null ? `${minutes} min on the GPU` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <ButtonLink href={`/dashboard/properties/${propertyId}/preview`} variant="secondary" size="sm">
              <Eye className="size-3.5" /> Walk through it
            </ButtonLink>
            {hasRemaster && (
              <div className="inline-flex rounded-full bg-linen p-0.5" role="group" aria-label="What buyers see">
                {(
                  [
                    [false, "Painted"],
                    [true, "Remastered"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => buyersSeeRemaster !== value && choose(value)}
                    disabled={busy}
                    aria-pressed={buyersSeeRemaster === value}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${buyersSeeRemaster === value ? "bg-white text-ink shadow-sm" : "text-neutral-500 hover:text-ink"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2 border-t border-linen pt-3">
            <p className="text-xs text-neutral-500">Remaster it again with the newest version of the AI (the photos are still on the server).</p>
            {needsPhotos}
            {startButton("Remaster again", "again")}
          </div>
        </div>
      )}

      {job?.status === "failed" && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="flex items-start gap-2 text-red-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> The GPU couldn&apos;t finish: {job.message ?? "unknown error"}
          </p>
          {needsPhotos}
          {startButton("Try again", "retry")}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
