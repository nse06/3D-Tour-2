import "server-only";
import { isSupabaseConfigured } from "@/lib/data/config";
import type { GrantKind, Plan } from "./plans";

/**
 * How a listing came to be paid for: bought ('purchase'), covered by a plan ('subscription',
 * 'pro_quota'), the realtor's first listing ('free'), an exempt account ('exempt'), photoreal
 * during the beta ('beta'), or published before billing started ('unbilled').
 */
export type GrantSource = "purchase" | "subscription" | "free" | "pro_quota" | "exempt" | "beta" | "unbilled";

export interface Grant {
  id: string;
  userId: string;
  /** null once the listing is deleted (the grant still counts: a used free listing stays used). */
  propertyId: string | null;
  kind: GrantKind;
  source: GrantSource;
  /** Checkout Session id for purchases; otherwise '<kind>:<listing>' or 'free:<user>'. Unique. */
  reference: string;
  amountCents: number;
  createdAt: string;
}

export type NewGrant = Omit<Grant, "id" | "createdAt">;

export interface SubscriptionRecord {
  /** Stripe's subscription id. */
  id: string;
  userId: string;
  customerId: string;
  plan: Plan;
  /** Stripe's status. */
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  updatedAt: string;
}

/** Statuses that keep a plan's benefits (past_due: Stripe is still retrying the card). */
export function isActiveSubscription(sub: SubscriptionRecord): boolean {
  return sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
}

export interface BillingStore {
  customerId(userId: string): Promise<string | null>;
  /** Keeps the first customer recorded for a realtor. */
  saveCustomer(userId: string, customerId: string): Promise<void>;
  userForCustomer(customerId: string): Promise<string | null>;
  subscriptions(userId: string): Promise<SubscriptionRecord[]>;
  saveSubscription(sub: SubscriptionRecord): Promise<void>;
  grants(userId: string, filter?: { propertyId?: string; kind?: GrantKind }): Promise<Grant[]>;
  /** Records a grant; false when one with the same reference exists already. */
  addGrant(grant: NewGrant): Promise<boolean>;
  /** Charging begins: listings live now keep their link (see the billing migration). */
  start(): Promise<void>;
}

let store: Promise<BillingStore> | null = null;

/**
 * Billing records are written only by the server: with Supabase, through the service-role client
 * (realtors can read their rows, never write them).
 */
export function getBillingStore(): Promise<BillingStore> {
  store ??= isSupabaseConfigured()
    ? import("./store-supabase").then((m) => new m.SupabaseBillingStore())
    : import("./store-local").then((m) => new m.LocalBillingStore());
  return store;
}
