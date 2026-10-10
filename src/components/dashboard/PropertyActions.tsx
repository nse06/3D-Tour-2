"use client";

import { Box, ExternalLink, Globe, Loader2, Lock, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { attachDemoCaptureAction, deletePropertyAction, setPublishedAction } from "@/app/dashboard/actions";
import { Button, buttonClass } from "@/components/ui";
import type { PublishPricing } from "@/lib/billing/plans";
import { CopyLinkButton } from "./CopyLinkButton";

export function PublishPanel({
  propertyId,
  slug,
  published,
  hasCapture,
  pricing,
}: {
  propertyId: string;
  slug: string;
  published: boolean;
  hasCapture: boolean;
  /** What publishing costs (null: nothing to say). */
  pricing: PublishPricing | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/tour/${slug}`;
  const toggle = () =>
    start(async () => {
      setError(null);
      const res = await setPublishedAction(propertyId, !published);
      if (res.checkoutUrl) {
        // Paid on Stripe's page; it comes back here with the tour live.
        setLeaving(true);
        window.location.assign(res.checkoutUrl);
        return;
      }
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      router.refresh();
    });
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className={`grid size-10 place-items-center rounded-2xl ${published ? "bg-emerald-50 text-emerald-700" : "bg-linen text-stone"}`}>
          {published ? <Globe className="size-5" strokeWidth={1.6} /> : <Lock className="size-5" strokeWidth={1.6} />}
        </span>
        <div>
          <p className="font-medium text-ink">{published ? "Live — anyone with the link can walk through" : "Draft — only you can preview"}</p>
          <p className="text-sm text-neutral-500">
            {published
              ? "Share the link in listings, texts and emails."
              : hasCapture
                ? "Publish to get a shareable public link."
                : "Attach a 3D capture to publish."}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-2xl border border-sand bg-paper/70 py-1.5 pl-4 pr-1.5">
        <span className={`flex-1 truncate font-mono text-[13px] ${published ? "text-ink" : "text-neutral-400"}`}>
          <PublicUrl path={path} />
        </span>
        <CopyLinkButton path={path} label="Copy" disabled={!published} />
        {published && (
          <a href={path} target="_blank" className={buttonClass("ghost", "sm")} aria-label="Open public tour">
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={toggle} disabled={pending || leaving || (!published && !hasCapture)} variant={published ? "secondary" : "primary"}>
          {(pending || leaving) && <Loader2 className="size-4 animate-spin" />}
          {published ? "Unpublish" : (pricing?.label ?? "Publish tour")}
        </Button>
      </div>
      {!published && pricing?.note && (
        <p className="mt-3 text-xs text-neutral-500">
          {pricing.note}{" "}
          {pricing.plans && (
            <Link href="/dashboard/billing" className="font-medium text-ink underline underline-offset-2">
              See plans
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

const noopSubscribe = () => () => {};

function PublicUrl({ path }: { path: string }) {
  // The real deployment origin is only known in the browser; the server renders the path alone.
  const host = useSyncExternalStore(
    noopSubscribe,
    () => window.location.host,
    () => "",
  );
  return (
    <span>
      {host}
      {path}
    </span>
  );
}

export function AttachDemoButton({ propertyId, replace }: { propertyId: string; replace: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (replace && !confirm("Replace the current capture (and its rooms) with the sample capture?")) return;
            const res = await attachDemoCaptureAction(propertyId);
            if (!res.ok) setError(res.error ?? "Could not attach the sample capture.");
            router.refresh();
          })
        }
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Box className="size-4" strokeWidth={1.6} />}
        Use sample capture
      </Button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function DeletePropertyButton({ propertyId, address }: { propertyId: string; address: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="danger"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Delete ${address}? This removes its tour and public link.`)) return;
        start(() => deletePropertyAction(propertyId));
      }}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete listing
    </Button>
  );
}
