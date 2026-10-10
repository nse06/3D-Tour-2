"use client";

import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { portalAction, subscribeAction, type BillingRedirect } from "@/app/dashboard/billing/actions";
import { Button } from "@/components/ui";
import type { Plan } from "@/lib/billing/plans";

function useStripeRedirect() {
  const [pending, start] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = (action: () => Promise<BillingRedirect>) =>
    start(async () => {
      setError(null);
      const res = await action();
      if (res.url) {
        setLeaving(true);
        window.location.assign(res.url);
      } else setError(res.error ?? "Something went wrong.");
    });
  return { busy: pending || leaving, error, go };
}

/** Opens Stripe's checkout for a plan (or the portal, to switch an existing one). */
export function PlanButton({ plan, label, primary }: { plan: Plan; label: string; primary?: boolean }) {
  const { busy, error, go } = useStripeRedirect();
  return (
    <div>
      <Button onClick={() => go(() => subscribeAction(plan))} disabled={busy} variant={primary ? "primary" : "secondary"} className="w-full">
        {busy && <Loader2 className="size-4 animate-spin" />} {label}
      </Button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** Stripe's billing portal: cards, invoices, plan changes, cancelling. */
export function ManageBillingButton({ label = "Manage billing" }: { label?: string }) {
  const { busy, error, go } = useStripeRedirect();
  return (
    <div>
      <Button onClick={() => go(portalAction)} disabled={busy} variant="secondary" size="sm">
        {busy && <Loader2 className="size-3.5 animate-spin" />} {label}
      </Button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
