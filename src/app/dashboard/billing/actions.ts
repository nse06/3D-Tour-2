"use server";

import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { activePlan } from "@/lib/billing/access";
import { billingEnabled } from "@/lib/billing/config";
import type { Plan } from "@/lib/billing/plans";
import { checkoutUrl, portalUrl } from "@/lib/billing/stripe";
import { requestOrigin } from "@/lib/request-origin";

export interface BillingRedirect {
  /** Stripe's checkout page or billing portal. */
  url?: string;
  error?: string;
}

const UNREACHABLE = "Stripe couldn't be reached. Please try again in a moment.";

/** Starts a plan; a realtor already on one switches in Stripe's portal (prorated) instead. */
export async function subscribeAction(plan: Plan): Promise<BillingRedirect> {
  const user = await requireUser();
  if (!billingEnabled()) return { error: "Billing isn't set up on this site." };
  if (plan !== "unlimited" && plan !== "pro") return { error: "Unknown plan." };
  try {
    const origin = requestOrigin(await headers());
    if (await activePlan(user.id)) {
      const url = await portalUrl(user.id, `${origin}/dashboard/billing`);
      return url ? { url } : { error: UNREACHABLE };
    }
    return { url: await checkoutUrl({ payer: user, price: plan, origin, cancelPath: "/dashboard/billing" }) };
  } catch (e) {
    console.error("billing: subscribe:", (e as Error).message);
    return { error: UNREACHABLE };
  }
}

/** Stripe's billing portal: cards, invoices, plan changes and cancelling. */
export async function portalAction(): Promise<BillingRedirect> {
  const user = await requireUser();
  if (!billingEnabled()) return { error: "Billing isn't set up on this site." };
  try {
    const url = await portalUrl(user.id, `${requestOrigin(await headers())}/dashboard/billing`);
    return url ? { url } : { error: "Nothing has been paid on this account yet." };
  } catch (e) {
    console.error("billing: portal:", (e as Error).message);
    return { error: UNREACHABLE };
  }
}
