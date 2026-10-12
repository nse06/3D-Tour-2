"use client";

import { AlertTriangle, CheckCircle2, Eye, Loader2, Play, RefreshCw, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { choosePhotorealVersionAction, deletePhotorealPhotosAction, retrainPhotorealAction, startPhotorealAction, type ActionResult } from "@/app/dashboard/actions";
import { Button, ButtonLink } from "@/components/ui";
import { PHOTOREAL_UNPAID, photorealParked, type PhotorealPricing } from "@/lib/billing/plans";
import type { PhotorealVariant } from "@/lib/data/types";

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
  /** The AI-enhanced version of the same photos (docs/photoreal.md §3.1). */
  ai: PhotorealVariant | null;
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
 * scan's photos, or how to start it from the phone; once it's done, training it again from the
 * photos kept on the server.
 */
export function PhotorealPanel({
  propertyId,
  initialJob,
  gpuReady,
  hasPhotoScan,
  pricing,
  photos,
  buyersSee,
  remasterFirst,
}: {
  propertyId: string;
  initialJob: PhotorealJobView | null;
  gpuReady: boolean;
  hasPhotoScan: boolean;
  /** What photoreal costs for this listing (null: nothing to say). */
  pricing: PhotorealPricing | null;
  /** The latest job's photos: still on the server (for training again), and how big. */
  photos: { kept: boolean; bytes: number } | null;
  /** Which of the job's versions buyers see (null: neither, e.g. a newer scan since). */
  buyersSee: "faithful" | "ai" | null;
  /** The phone's photos make the remastered model first; photoreal starts only from here. */
  remasterFirst: boolean;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const parked = job?.status === "queued" && photorealParked(job.message);
  const moving =
    job && (job.status === "uploading" || (job.status === "queued" && !parked) || job.status === "running" || job.ai?.status === "running");

  // While the job moves, follow it; once it's done, show the new look on the page.
  useEffect(() => {
    if (!moving) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const res = await fetch(`/api/properties/${propertyId}/photoreal`, { cache: "no-store" }).catch(() => null);
      if (stopped || !res?.ok) return;
      const next = (await res.json()).job as PhotorealJobView | null;
      if (!next) return;
      setJob((previous) => {
        // Done, or its AI-enhanced version just finished: show the new look on the page.
        if ((next.status === "done" && previous?.status !== "done") || (next.ai?.status !== "running" && previous?.ai?.status === "running")) router.refresh();
        return next;
      });
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [moving, propertyId, router]);

  const run = (action: (propertyId: string) => Promise<ActionResult>, fallback: string) =>
    startTransition(async () => {
      setError(null);
      const res = await action(propertyId);
      if (res.checkoutUrl) {
        // Paid on Stripe's page; training starts when it comes back.
        setLeaving(true);
        window.location.assign(res.checkoutUrl);
        return;
      }
      if (!res.ok) setError(res.error ?? fallback);
      const latest = await fetch(`/api/properties/${propertyId}/photoreal`, { cache: "no-store" }).catch(() => null);
      if (latest?.ok) setJob((await latest.json()).job);
      router.refresh();
    });
  const start = () => run(startPhotorealAction, "The GPU didn't take the job.");
  const choose = (version: "faithful" | "ai") => run((id) => choosePhotorealVersionAction(id, version), "That version couldn't be chosen.");
  const retrain = () => run(retrainPhotorealAction, "The GPU didn't take the job.");
  const deletePhotos = () => {
    if (!window.confirm("Delete the photos kept for training again? The walkthrough stays; training again would need the photos sent from the phone.")) return;
    run(deletePhotorealPhotosAction, "The photos couldn't be deleted.");
  };

  const busy = pending || leaving;
  const pay = !!pricing?.pay;
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
                It uploads the photos (a few hundred MB, best on Wi-Fi)
                {remasterFirst
                  ? ". The remastered model starts from them by itself; photoreal is optional, started here once they're in (about half an hour)."
                  : " and takes about half an hour."}
              </>
            ) : (
              <>Send a scan from Atrium Capture first: photoreal is made from its photos.</>
            )}
          </p>
          {pricing?.note && <p className="text-xs text-neutral-500">{pricing.note}</p>}
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
          <p className="text-neutral-600">
            {parked
              ? "The photos are here and went to the remastered model. Photoreal is optional: start it if you want it as well."
              : pay
                ? "The photos are here. Training starts as soon as photoreal is paid for."
                : "The photos are here and waiting for the GPU."}
          </p>
          {pricing?.note && <p className="text-xs text-neutral-500">{pricing.note}</p>}
          {job.message && job.message !== PHOTOREAL_UNPAID && !parked && <p className="text-xs text-neutral-400">{job.message}</p>}
          {gpuReady && (
            <Button onClick={start} disabled={busy} size="sm">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : pay ? <Sparkles className="size-3.5" /> : <Play className="size-3.5" />}{" "}
              {pay ? pricing!.payLabel : parked ? "Start photoreal" : "Start"}
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
          {job.ai && <AiVersion ai={job.ai} buyersSee={buyersSee} busy={busy} onChoose={choose} />}
          <TrainAgain photos={photos} gpuReady={gpuReady} busy={busy} pay={pay} payLabel={pricing?.payLabel} onRetrain={retrain} onDelete={deletePhotos} />
        </div>
      )}

      {job?.status === "failed" && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="flex items-start gap-2 text-red-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> The GPU couldn&apos;t finish: {job.message ?? "unknown error"}
          </p>
          {gpuReady && (
            <Button onClick={start} disabled={busy} size="sm" variant="secondary">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} {pay ? pricing!.payLabel : "Try again"}
            </Button>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}

/**
 * The AI-enhanced version (docs/photoreal.md §3.1): on its way, or ready to compare with the faithful
 * one and choose for buyers.
 */
function AiVersion({
  ai,
  buyersSee,
  busy,
  onChoose,
}: {
  ai: PhotorealVariant;
  buyersSee: "faithful" | "ai" | null;
  busy: boolean;
  onChoose: (version: "faithful" | "ai") => void;
}) {
  return (
    <div className="space-y-2 border-t border-linen pt-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <Wand2 className="size-3.5" /> AI-enhanced version
      </p>
      {ai.status === "running" && (
        <>
          <p className="flex items-center gap-2 text-xs text-neutral-600">
            <Loader2 className="size-3.5 animate-spin" /> On its way — {Math.round(ai.progress * 100)}%. An AI model cleans up the views between the photo spots (haze,
            smears, gaps) and the walkthrough learns from them; about 15 minutes.
          </p>
          <div className="h-1 overflow-hidden rounded-full bg-linen">
            <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${Math.max(3, ai.progress * 100)}%` }} />
          </div>
        </>
      )}
      {ai.status === "failed" && (
        <p className="text-xs text-amber-700">It couldn&apos;t be made this time ({ai.message ?? "unknown error"}). The faithful version above is unaffected.</p>
      )}
      {ai.status === "done" && (
        <>
          <p className="text-xs text-neutral-500">
            Two versions from the same photos. <b className="font-semibold text-neutral-700">Faithful</b> shows only what the photos saw;{" "}
            <b className="font-semibold text-neutral-700">AI-enhanced</b> had an AI clean up the views between the photo spots, so it&apos;s smoother there and may
            invent small details. Compare them in the walkthrough, then pick what buyers see:
          </p>
          <div className="inline-flex rounded-full bg-linen p-0.5" role="group" aria-label="What buyers see">
            {(["faithful", "ai"] as const).map((version) => (
              <button
                key={version}
                type="button"
                onClick={() => buyersSee !== version && onChoose(version)}
                disabled={busy}
                aria-pressed={buyersSee === version}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${buyersSee === version ? "bg-white text-ink shadow-sm" : "text-neutral-500 hover:text-ink"}`}
              >
                {version === "ai" ? "AI-enhanced" : "Faithful"}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Training the listing again from the photos kept on the server, or why it can't be. */
function TrainAgain({
  photos,
  gpuReady,
  busy,
  pay,
  payLabel,
  onRetrain,
  onDelete,
}: {
  photos: { kept: boolean; bytes: number } | null;
  gpuReady: boolean;
  busy: boolean;
  pay: boolean;
  payLabel?: string;
  onRetrain: () => void;
  onDelete: () => void;
}) {
  if (!photos) return null;
  if (!photos.kept) {
    return (
      <p className="border-t border-linen pt-3 text-xs text-neutral-500">
        To train it again, open this scan in Atrium Capture and tap <b className="font-semibold">Make it photoreal again</b>: the photos aren&apos;t on the
        server anymore.
      </p>
    );
  }
  return (
    <div className="space-y-2 border-t border-linen pt-3">
      <p className="text-xs text-neutral-500">
        The scan&apos;s photos ({megabytes(photos.bytes)}) are kept on the server, so this walkthrough can be trained again with the newest trainer — no
        rescan. Buyers keep seeing this one until the new one is ready (45–60 minutes).
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {gpuReady && (
          <Button onClick={onRetrain} disabled={busy} size="sm" variant="secondary">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {pay && payLabel ? payLabel : "Train again"}
          </Button>
        )}
        <button type="button" onClick={onDelete} disabled={busy} className="text-xs text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline">
          Delete the photos
        </button>
      </div>
    </div>
  );
}
