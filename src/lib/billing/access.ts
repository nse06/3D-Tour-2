import "server-only";
import { LOCAL_USER } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/data/config";
import { adminRepositoryUnavailableReason } from "@/lib/data/repository";
import { billingEnabled, chargeForPhotoreal, exemptionsConfigured, isExemptEmail } from "./config";
import { PRICES, PRO_PHOTOREAL_INCLUDED, type PriceKey } from "./plans";
import { getBillingStore, isActiveSubscription, type NewGrant, type SubscriptionRecord } from "./store";

// Who pays for what (docs/billing.md):
//   publishing a listing: $19 once, unless it's the realtor's first listing or they're on a plan;
//   photoreal: $20 a listing (Pro: 5 a month included, then $15), free for everyone during the beta.
// A listing paid for once stays paid for: republishing, rescanning and retraining cost nothing.

export interface Payer {
  id: string;
  email: string | null;
}

/** Why an action costs nothing. */
export type FreeReason = "billing-off" | "paid" | "exempt" | "plan" | "first-listing" | "pro-included" | "beta";

export type Allowed = { allowed: true; reason: FreeReason; plan: SubscriptionRecord | null; grant: NewGrant | null };
export type Access = Allowed | { allowed: false; price: PriceKey; amount: number; plan: SubscriptionRecord | null };

/** The realtor's plan, if they have one now. */
export async function activePlan(userId: string): Promise<SubscriptionRecord | null> {
  return (await (await getBillingStore()).subscriptions(userId)).find(isActiveSubscription) ?? null;
}

let started: Promise<void> | null = null;

/** Once per server: charging has begun (listings live now keep their link; see the migration). */
function ensureStarted(): Promise<void> {
  started ??= getBillingStore()
    .then((store) => store.start())
    .catch((e) => {
      started = null;
      throw e;
    });
  return started;
}

export async function listingAccess(payer: Payer, propertyId: string): Promise<Access> {
  const grant = (source: NewGrant["source"], reference = `listing:${propertyId}`): NewGrant => ({
    userId: payer.id,
    propertyId,
    kind: "listing",
    source,
    reference,
    amountCents: 0,
  });
  if (!billingEnabled()) return { allowed: true, reason: "billing-off", plan: null, grant: grant("unbilled") };
  await ensureStarted();
  const store = await getBillingStore();
  const [owned, plan] = await Promise.all([store.grants(payer.id, { propertyId, kind: "listing" }), activePlan(payer.id)]);
  if (owned.length) return { allowed: true, reason: "paid", plan, grant: null };
  if (isExemptEmail(payer.email)) return { allowed: true, reason: "exempt", plan, grant: grant("exempt") };
  if (plan) return { allowed: true, reason: "plan", plan, grant: grant("subscription") };
  const listings = await store.grants(payer.id, { kind: "listing" });
  if (!listings.some((g) => g.source === "free")) return { allowed: true, reason: "first-listing", plan, grant: grant("free", `free:${payer.id}`) };
  return { allowed: false, price: "listing", amount: PRICES.listing.amount, plan };
}

export async function photorealAccess(payer: Payer, propertyId: string): Promise<Access> {
  const grant = (source: NewGrant["source"]): NewGrant => ({
    userId: payer.id,
    propertyId,
    kind: "photoreal",
    source,
    reference: `photoreal:${propertyId}`,
    amountCents: 0,
  });
  // Listings made photoreal before charging starts keep it (retraining included).
  if (!billingEnabled()) return { allowed: true, reason: "billing-off", plan: null, grant: grant("unbilled") };
  if (!chargeForPhotoreal()) return { allowed: true, reason: "beta", plan: null, grant: grant("beta") };
  await ensureStarted();
  const store = await getBillingStore();
  const [owned, plan] = await Promise.all([store.grants(payer.id, { propertyId, kind: "photoreal" }), activePlan(payer.id)]);
  if (owned.length) return { allowed: true, reason: "paid", plan, grant: null };
  if (isExemptEmail(payer.email)) return { allowed: true, reason: "exempt", plan, grant: grant("exempt") };
  if (plan?.plan === "pro") {
    if ((await proPhotorealUsed(payer.id, plan)) < PRO_PHOTOREAL_INCLUDED) return { allowed: true, reason: "pro-included", plan, grant: grant("pro_quota") };
    return { allowed: false, price: "photorealPro", amount: PRICES.photorealPro.amount, plan };
  }
  return { allowed: false, price: "photoreal", amount: PRICES.photoreal.amount, plan };
}

/** Photoreal listings Pro has covered in the current billing month. */
export async function proPhotorealUsed(userId: string, plan: SubscriptionRecord): Promise<number> {
  const since = plan.currentPeriodStart ? Date.parse(plan.currentPeriodStart) : Date.now() - 31 * 24 * 3600 * 1000;
  const grants = await (await getBillingStore()).grants(userId, { kind: "photoreal" });
  return grants.filter((g) => g.source === "pro_quota" && Date.parse(g.createdAt) >= since).length;
}

/**
 * Records what an allowed action used. False only when it was the free first listing and another
 * listing claimed it a moment ago (ask again: it costs money now). Without billing, the record is a
 * courtesy for later, so a database that can't take it doesn't stop the action.
 */
export async function claim(access: Allowed): Promise<boolean> {
  if (!access.grant) return true;
  if (access.reason === "billing-off") {
    if (adminRepositoryUnavailableReason()) return true;
    try {
      await (await getBillingStore()).addGrant(access.grant);
    } catch (e) {
      console.warn("billing: couldn't note an unbilled listing:", (e as Error).message);
    }
    return true;
  }
  const added = await (await getBillingStore()).addGrant(access.grant);
  return added || access.grant.source !== "free";
}

/** The realtor behind a phone's pairing code, with the email exemptions are matched on. */
export async function payerFor(userId: string): Promise<Payer> {
  if (!isSupabaseConfigured()) return { id: userId, email: userId === LOCAL_USER.id ? LOCAL_USER.email : null };
  if (!exemptionsConfigured()) return { id: userId, email: null };
  const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createSupabaseAdminClient().auth.admin.getUserById(userId);
  return { id: userId, email: data.user?.email ?? null };
}
