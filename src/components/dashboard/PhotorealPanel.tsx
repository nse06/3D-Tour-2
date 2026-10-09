"use client";

import { AlertTriangle, CheckCircle2, Eye, Loader2, Play, RotateCcw, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { startPhotorealAction } from "@/app/dashboard/actions";
import { Button, ButtonLink } from "@/components/ui";

export interface PhotorealJobView {
  id: string;
  status: "uploading" | "queued" | "running" | "done" | "failed";
  stage: string | null;
  progress: number;
  message: string | null;
  files: number;
  bytes: number;
  splatUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: Record<string, unknown> | null;
}

const POLL_MS = 5000;
const STAGE: Record<string, string> = {
  starting: "Starting the GPU",
  downloading: "The GPU is downloading the photos",
  training: "Training on your photos",
  uploading: "Saving the photoreal walkthrough",
};

function megabytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * The listing's photoreal walkthrough (docs/photoreal.md): what the cloud GPU is doing with the
 * scan's photos, or how to start it from the phone.
 */
export function PhotorealPanel({
  propertyId,
  initialJob,
  gpuReady,
  hasPhotoScan,
}: {
  propertyId: string;
  initialJob: PhotorealJobView | null;
  gpuReady: boolean;
  hasPhotoScan: boolean;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const moving = job && (job.status === "uploading" || job.status === "queued" || job.status === "running");

  // While the job moves, follow it; once it's done, show the new look on the page.
  useEffect(() => {
    if (!moving) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const res = await fetch(`/api/properties/${propertyId}/photoreal`, { cache: "no-store" }).catch(() => null);
      if (stopped || !res?.ok) return;
      const next = (await res.json()).job as PhotorealJobView | null;
      if (!next) return;
      setJob(next);
      if (next.status === "done") router.refresh();
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [moving, propertyId, router]);

  const start = () =>
    startTransition(async () => {
      setError(null);
      const res = await startPhotorealAction(propertyId);
      if (!res.ok) setError(res.error ?? "The GPU didn't take the job.");
      const latest = await fetch(`/api/properties/${propertyId}/photoreal`, { cache: "no-store" }).catch(() => null);
      if (latest?.ok) setJob((await latest.json()).job);
    });

  const stats = job?.stats ?? {};
  const minutes = job?.startedAt && job.finishedAt ? Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60000) : null;

  return (
    <div>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">
        <Sparkles className="size-3.5" /> Photoreal walkthrough <span className="rounded-full bg-linen px-2 py-0.5 text-[10px] tracking-[0.1em]">Beta</span>
      </p>

      {!job && (
        <div className="mt-3 space-y-2 text-sm text-neutral-600">
          <p>
            A cloud GPU learns your home from the scan&apos;s photos — window views, reflections and every plant included — and buyers can switch to it in the
            walkthrough.
          </p>
          <p>
            {hasPhotoScan ? (
              <>
                In <b className="font-semibold text-ink">Atrium Capture</b>, open this scan and tap <b className="font-semibold text-ink">Make it photoreal</b>.
                It uploads the photos (a few hundred MB, best on Wi-Fi) and takes about half an hour.
              </>
            ) : (
              <>Send a scan from Atrium Capture first: photoreal is made from its photos.</>
            )}
          </p>
          {!gpuReady && <p className="text-xs text-neutral-400">The GPU isn&apos;t connected to this site yet (see docs/photoreal.md).</p>}
        </div>
      )}

      {job?.status === "uploading" && (
        <p className="mt-3 flex items-center gap-2 text-sm text-neutral-600">
          <Loader2 className="size-4 animate-spin" /> Receiving {job.files} photos and files from the phone ({megabytes(job.bytes)})…
        </p>
      )}

      {job?.status === "queued" && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-neutral-600">The photos are here and waiting for the GPU.</p>
          {job.message && <p className="text-xs text-neutral-400">{job.message}</p>}
          {gpuReady && (
            <Button onClick={start} disabled={pending} size="sm">
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start
            </Button>
          )}
        </div>
      )}

      {job?.status === "running" && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="flex items-center gap-2 text-neutral-700">
            <Loader2 className="size-4 animate-spin" /> {STAGE[job.stage ?? ""] ?? "Working"}
            {job.stage === "training" && ` — ${Math.round(job.progress * 100)}%`}
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
            <span>
              Ready. Buyers can switch to <b className="font-semibold">Photoreal</b> in the walkthrough, and you can make it what they see first in{" "}
              <b className="font-semibold">Rooms &amp; viewpoints</b>.
            </span>
          </p>
          {job.message && <p className="text-xs text-amber-700">{job.message}</p>}
          <p className="text-xs text-neutral-400">
            {[
              typeof stats.splats === "number" ? `${(stats.splats / 1e6).toFixed(2)} M splats` : null,
              typeof stats.bytes === "number" ? megabytes(stats.bytes) : null,
              minutes != null ? `${minutes} min on the GPU` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <ButtonLink href={`/dashboard/properties/${propertyId}/preview`} variant="secondary" size="sm">
            <Eye className="size-3.5" /> Walk through it
          </ButtonLink>
        </div>
      )}

      {job?.status === "failed" && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="flex items-start gap-2 text-red-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> The GPU couldn&apos;t finish: {job.message ?? "unknown error"}
          </p>
          {gpuReady && (
            <Button onClick={start} disabled={pending} size="sm" variant="secondary">
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Try again
            </Button>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
