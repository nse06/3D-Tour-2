import "server-only";
import Stripe from "stripe";
import { getAdminRepository } from "@/lib/data/repository";
import { dispatchJob, inputNames } from "@/lib/photoreal";
import type { Payer } from "./access";
import { stripeApiOverride, stripeSecretKey } from "./config";
import { PRICES, type Plan, type PriceKey, type PriceSpec } from "./plans";
import { getBillingStore, type SubscriptionRecord } from "./store";

// Atrium's side of Stripe (docs/billing.md): Checkout for purchases and plans, the customer
// portal for cards, invoices and plan changes, and turning finished checkouts and subscription
// changes into billing records. Payment happens on Stripe's pages, never in the iPhone app.

let client: Stripe | null = null;

export function stripe(): Stripe {
  const key = stripeSecretKey();
  if (!key) throw new Error("Billing isn't set up: STRIPE_SECRET_KEY is missing.");
  client ??= new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Atrium" }, ...stripeApiOverride() });
  return client;
}

const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === "string" ? value : (value?.id ?? null));

const isoFrom = (seconds: number | null | undefined): string | null => (seconds ? new Date(seconds * 1000).toISOString() : null);

// ---------------------------------------------------------------------------
// Prices: found by lookup key, created the first time they're needed
// ---------------------------------------------------------------------------

const prices = new Map<PriceKey, Promise<Stripe.Price>>();

export function priceFor(key: PriceKey): Promise<Stripe.Price> {
  let price = prices.get(key);
  if (!price) {
    price = findOrCreatePrice(PRICES[key]);
    prices.set(key, price);
    price.catch(() => prices.delete(key));
  }
  return price;
}

function matches(price: Stripe.Price | undefined, spec: PriceSpec): boolean {
  return (
    !!price &&
    price.active &&
    price.currency === "usd" &&
    price.unit_amount === spec.amount &&
    price.recurring?.interval === spec.interval &&
    (price.recurring?.interval_count ?? 1) === 1
  );
}

async function findOrCreatePrice(spec: PriceSpec): Promise<Stripe.Price> {
  const lookup = async () => (await stripe().prices.list({ lookup_keys: [spec.lookupKey], limit: 1 })).data[0];
  const existing = await lookup();
  if (existing && matches(existing, spec)) return existing;
  try {
    return await stripe().prices.create({
      currency: "usd",
      unit_amount: spec.amount,
      lookup_key: spec.lookupKey,
      // A changed amount takes the key over; subscriptions on the old price keep it.
      transfer_lookup_key: !!existing,
      metadata: { atrium: spec.key },
      ...(spec.interval ? { recurring: { interval: spec.interval } } : {}),
      ...(existing ? { product: idOf(existing.product)! } : { product_data: { name: spec.name, metadata: { atrium: spec.key } } }),
    });
  } catch (e) {
    // Another server instance made it a moment ago.
    const raced = await lookup();
    if (raced && matches(raced, spec)) return raced;
    throw e;
  }
}

/** Which plan a subscription's price is (prices remember theirs, even after an amount change). */
function planOf(price: Stripe.Price | undefined): Plan | null {
  const key = price?.metadata?.atrium ?? Object.values(PRICES).find((p) => p.lookupKey === price?.lookup_key)?.key;
  return key === "unlimited" || key === "pro" ? key : null;
}

// ---------------------------------------------------------------------------
// Checkout and the customer portal
// ---------------------------------------------------------------------------

export interface CheckoutRequest {
  payer: Payer;
  price: PriceKey;
  /** The listing a one-time purchase is for. */
  propertyId?: string;
  /** Shown on the receipt (the listing's address). */
  description?: string;
  /** The site's address as the realtor's browser knows it. */
  origin: string;
  /** Where Stripe's back link leads. */
  cancelPath: string;
}

/** Stripe's checkout page for a purchase or a plan. */
export async function checkoutUrl(req: CheckoutRequest): Promise<string> {
  const spec = PRICES[req.price];
  const [price, customer] = await Promise.all([priceFor(req.price), getBillingStore().then((s) => s.customerId(req.payer.id))]);
  const recurring = !!spec.interval;
  const kind = recurring ? "plan" : req.price === "listing" ? "listing" : "photoreal";
  const metadata: Record<string, string> = { userId: req.payer.id, kind, price: req.price };
  if (req.propertyId) metadata.propertyId = req.propertyId;
  const session = await stripe().checkout.sessions.create({
    mode: recurring ? "subscription" : "payment",
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${req.origin}/api/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${req.origin}${req.cancelPath}`,
    client_reference_id: req.payer.id,
    metadata,
    allow_promotion_codes: true,
    ...(customer
      ? { customer }
      : { ...(req.payer.email ? { customer_email: req.payer.email } : {}), ...(recurring ? {} : { customer_creation: "always" as const }) }),
    ...(recurring
      ? { subscription_data: { metadata: { userId: req.payer.id } } }
      : { payment_intent_data: { metadata, ...(req.description ? { description: req.description } : {}) } }),
  });
  if (!session.url) throw new Error("Stripe didn't return a checkout page.");
  return session.url;
}

let portalConfiguration: Promise<string> | null = null;

/** The portal lets realtors switch between Unlimited and Pro, cancel, change cards and get invoices. */
function ensurePortalConfiguration(): Promise<string> {
  portalConfiguration ??= (async () => {
    const [unlimited, pro] = await Promise.all([priceFor("unlimited"), priceFor("pro")]);
    const version = `${unlimited.id}:${pro.id}`;
    for await (const config of stripe().billingPortal.configurations.list({ active: true, limit: 100 })) {
      if (config.metadata?.atrium === version) return config.id;
    }
    const config = await stripe().billingPortal.configurations.create({
      business_profile: { headline: "Atrium: 3D walkthroughs for your listings" },
      features: {
        customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "tax_id"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          proration_behavior: "create_prorations",
          products: [
            { product: idOf(unlimited.product)!, prices: [unlimited.id] },
            { product: idOf(pro.product)!, prices: [pro.id] },
          ],
        },
      },
      metadata: { atrium: version },
    });
    return config.id;
  })().catch((e) => {
    portalConfiguration = null;
    throw e;
  });
  return portalConfiguration;
}

/** Stripe's billing portal for the realtor, or null if they've never paid. */
export async function portalUrl(userId: string, returnUrl: string): Promise<string | null> {
  const customer = await (await getBillingStore()).customerId(userId);
  if (!customer) return null;
  const configuration = await ensurePortalConfiguration().catch((e) => {
    // Stripe's default portal settings still work for invoices and cards.
    console.error("billing: portal configuration:", (e as Error).message);
    return undefined;
  });
  const session = await stripe().billingPortal.sessions.create({ customer, return_url: returnUrl, ...(configuration ? { configuration } : {}) });
  return session.url;
}

// ---------------------------------------------------------------------------
// Recording what was paid for
// ---------------------------------------------------------------------------

/** Stores a subscription's current state (fetched fresh: webhook events can arrive out of order). */
export async function syncSubscription(subscriptionId: string, knownUserId?: string): Promise<SubscriptionRecord | null> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const store = await getBillingStore();
  const customerId = idOf(sub.customer);
  const userId = knownUserId || sub.metadata?.userId || (customerId ? await store.userForCustomer(customerId) : null);
  const item = sub.items.data.find((i) => planOf(i.price));
  const plan = planOf(item?.price);
  // Not one of Atrium's plans (something else sold on the same Stripe account).
  if (!userId || !customerId || !item || !plan) return null;
  const record: SubscriptionRecord = {
    id: sub.id,
    userId,
    customerId,
    plan,
    status: sub.status,
    currentPeriodStart: isoFrom(item.current_period_start),
    currentPeriodEnd: isoFrom(item.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end || !!sub.cancel_at,
    updatedAt: new Date().toISOString(),
  };
  await store.saveCustomer(userId, customerId);
  await store.saveSubscription(record);
  return record;
}

export interface AppliedCheckout {
  kind: "listing" | "photoreal" | "plan";
  propertyId: string | null;
  plan: Plan | null;
  /** Paid by a method that clears later (a bank debit): the webhook finishes it then. */
  pending: boolean;
}

/**
 * Records a finished checkout, once, however many times it's reported (the return page and the
 * webhook both report it), and does what the realtor paid for: publishes the listing, or starts
 * the photoreal walkthrough waiting for it. `baseUrl` is this server's address for the GPU worker.
 */
export async function applyCheckoutSession(session: Stripe.Checkout.Session, baseUrl: string): Promise<AppliedCheckout | null> {
  const meta = session.metadata ?? {};
  const userId = meta.userId;
  if (!userId || session.status !== "complete") return null;
  const store = await getBillingStore();
  const customerId = idOf(session.customer);
  if (customerId) await store.saveCustomer(userId, customerId);

  if (session.mode === "subscription") {
    const subscriptionId = idOf(session.subscription);
    const record = subscriptionId ? await syncSubscription(subscriptionId, userId) : null;
    return { kind: "plan", propertyId: null, plan: record?.plan ?? null, pending: false };
  }

  const kind = meta.kind === "listing" || meta.kind === "photoreal" ? meta.kind : null;
  const propertyId = meta.propertyId || null;
  if (!kind || !propertyId) return null;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return { kind, propertyId, plan: null, pending: true };
  const added = await store.addGrant({ userId, propertyId, kind, source: "purchase", reference: session.id, amountCents: session.amount_total ?? 0 });
  if (added) await fulfil(kind, userId, propertyId, baseUrl);
  return { kind, propertyId, plan: null, pending: false };
}

async function fulfil(kind: "listing" | "photoreal", userId: string, propertyId: string, baseUrl: string) {
  try {
    const repo = await getAdminRepository();
    if (kind === "listing") {
      await repo.setPublished(userId, propertyId, true);
      return;
    }
    // The job the realtor paid from: waiting for payment, or a failed run they're retrying.
    const job = await repo.latestPhotorealJob(userId, propertyId);
    if ((job?.status === "queued" || job?.status === "failed") && (await inputNames(job)).length >= job.files) await dispatchJob(repo, job, baseUrl);
  } catch (e) {
    // It's paid for either way: Publish or Start on the listing page finishes it at no charge.
    console.error(`billing: couldn't finish a paid ${kind}:`, (e as Error).message);
  }
}

/** A verified Stripe webhook event. */
export async function handleStripeEvent(event: Stripe.Event, baseUrl: string): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await applyCheckoutSession(event.data.object, baseUrl);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await syncSubscription(event.data.object.id);
      return;
  }
}
