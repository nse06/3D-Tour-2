"use client";

import { Check, CheckCircle2, Copy, Eye, Loader2, Pencil, Smartphone, Wifi } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createCaptureSessionAction, type PhonePairing } from "@/app/dashboard/actions";
import { Button, ButtonLink, buttonClass } from "@/components/ui";

type State =
  | { step: "idle"; error?: string }
  | { step: "connecting" }
  | { step: "waiting"; pairing: PhonePairing; baselineTourId: string | null }
  | { step: "received"; rooms: number; floors: number };

interface CaptureStatus {
  tour: { id: string; source: string } | null;
  rooms: number;
  floors: number;
}

const POLL_MS = 3000;

/**
 * "Scan with iPhone": pairs the Atrium Capture app with this listing via a QR
 * code, then waits for the scan to arrive (docs/iphone-capture.md §3.1).
 */
export function PhoneCapturePanel({ propertyId, tourId, autoStart = false }: { propertyId: string; tourId: string | null; autoStart?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>(autoStart ? { step: "connecting" } : { step: "idle" });

  const connect = () => {
    setState({ step: "connecting" });
    void pair();
  };

  async function pair() {
    // A tour other than this one appearing later means the phone's scan arrived.
    const baselineTourId = tourId;
    const res = await createCaptureSessionAction(propertyId).catch((e: Error) => ({ ok: false as const, error: e.message, pairing: undefined }));
    if (res.ok && res.pairing) setState({ step: "waiting", pairing: res.pairing, baselineTourId });
    else setState({ step: "idle", error: res.error ?? "Could not create a pairing code." });
  }

  // Opened from "Create listing → Scan with iPhone": pair right away, and drop ?scan=1 so a reload doesn't pair again.
  const autoStarted = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    void pair();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // While the code is showing, watch for the scan to land.
  const waiting = state.step === "waiting" ? state : null;
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (Date.parse(waiting.pairing.expiresAt) < Date.now()) {
        clearInterval(timer);
        setState({ step: "idle", error: "The pairing code expired. Create a new one." });
        return;
      }
      try {
        const res = await fetch(`/api/properties/${propertyId}/capture-status`, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const status = (await res.json()) as CaptureStatus;
        if (status.tour && status.tour.id !== waiting.baselineTourId && status.tour.source === "ios_scan") {
          clearInterval(timer);
          setState({ step: "received", rooms: status.rooms, floors: status.floors });
          router.refresh();
        }
      } catch {
        // Offline for a moment — keep polling.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [waiting, propertyId, router]);

  return (
    <div ref={rootRef} className="scroll-mt-24">
      <div className="flex items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-white">
          <Smartphone className="size-5" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-medium">Scan with iPhone</p>
          <p className="text-sm text-neutral-500">
            Walk the home with the Atrium Capture app on an iPhone with LiDAR. Rooms, floor plan and the walkthrough path are built automatically.
          </p>
        </div>
      </div>

      {(state.step === "idle" || state.step === "connecting") && (
        <div className="mt-5">
          <Button onClick={connect} disabled={state.step === "connecting"}>
            {state.step === "connecting" ? <Loader2 className="size-4 animate-spin" /> : <Smartphone className="size-4" strokeWidth={1.6} />}
            Connect an iPhone
          </Button>
          {state.step === "idle" && state.error && <p className="mt-3 text-sm text-red-600">{state.error}</p>}
          <p className="mt-3 text-xs text-neutral-500">Needs iPhone 12 Pro or a newer Pro model (LiDAR) with the Atrium Capture app installed.</p>
        </div>
      )}

      {state.step === "waiting" && <PairingCode pairing={state.pairing} onCancel={() => setState({ step: "idle" })} />}

      {state.step === "received" && (
        <div className="mt-5 rounded-2xl bg-emerald-50 px-5 py-4">
          <p className="flex items-center gap-2 font-medium text-emerald-900">
            <CheckCircle2 className="size-5" /> Scan received
          </p>
          <p className="mt-1 text-sm text-emerald-900/80">
            {state.rooms} room{state.rooms === 1 ? "" : "s"} on {state.floors} floor{state.floors === 1 ? "" : "s"} — the walkthrough is ready to preview.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ButtonLink href={`/dashboard/properties/${propertyId}/preview`} size="sm">
              <Eye className="size-3.5" /> Walk through it
            </ButtonLink>
            <ButtonLink href={`/dashboard/properties/${propertyId}/rooms`} variant="secondary" size="sm">
              <Pencil className="size-3.5" /> Adjust rooms
            </ButtonLink>
            <Button variant="ghost" size="sm" onClick={connect}>
              Scan again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PairingCode({ pairing, onCancel }: { pairing: PhonePairing; onCancel: () => void }) {
  const [copied, setCopied] = useState(false);
  const expires = new Date(pairing.expiresAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div className="mt-5 grid gap-5 sm:grid-cols-[auto_1fr]">
      <div className="self-start justify-self-center rounded-2xl bg-white p-3 shadow-sm ring-1 ring-sand sm:justify-self-start">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={pairing.qrCode} alt="Pairing code for the Atrium Capture app" className="size-44" />
      </div>
      <div className="text-sm text-neutral-700">
        <ol className="space-y-2">
          <li>
            <b className="font-medium text-ink">1.</b> Point the iPhone&apos;s camera at the code and tap{" "}
            <b className="font-medium text-ink">Open in Atrium Capture</b> (or scan it from the app).
          </li>
          <li>
            <b className="font-medium text-ink">2.</b> Scan room by room, then tap <b className="font-medium text-ink">Send to Atrium</b>.
          </li>
          <li>
            <b className="font-medium text-ink">3.</b> This page updates as soon as the scan arrives.
          </li>
        </ol>
        {pairing.lan && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
            <Wifi className="mt-0.5 size-4 shrink-0" />
            <span>
              Keep the iPhone on the same Wi-Fi as this computer — it uploads to <span className="font-mono text-[12px]">{pairing.serverUrl}</span>.
            </span>
          </p>
        )}
        <p className="mt-3 flex items-center gap-2 text-[13px] text-neutral-500">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-gold opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-gold" />
          </span>
          Waiting for the scan · code works until {expires}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={pairing.deepLink} className={buttonClass("secondary", "sm")}>
            <Smartphone className="size-3.5" /> Open in Atrium Capture
          </a>
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            title="Copy the pairing link to send it to the iPhone (Messages, AirDrop, Notes)"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(pairing.deepLink);
              } catch {
                window.prompt("Copy this link", pairing.deepLink);
              }
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy link"}
          </button>
          <button type="button" className={buttonClass("ghost", "sm")} onClick={onCancel}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
