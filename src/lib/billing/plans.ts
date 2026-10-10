// What Atrium charges (docs/billing.md). Amounts are US cents. Stripe prices are found, or created
// on first use, by lookup key, so changing an amount here makes a new price for new purchases.

export type PriceKey = "listing" | "photoreal" | "photorealPro" | "unlimited" | "pro";
export type Plan = "unlimited" | "pro";
export type GrantKind = "listing" | "photoreal";

export interface PriceSpec {
  key: PriceKey;
  lookupKey: string;
  /** The product's name on Stripe's checkout page, receipts and invoices. */
  name: string;
  amount: number;
  interval?: "month";
}

export const PRICES: Record<PriceKey, PriceSpec> = {
  listing: { key: "listing", lookupKey: "atrium_listing", name: "Atrium listing", amount: 1900 },
  photoreal: { key: "photoreal", lookupKey: "atrium_photoreal", name: "Photoreal walkthrough", amount: 2000 },
  photorealPro: { key: "photorealPro", lookupKey: "atrium_photoreal_pro", name: "Photoreal walkthrough (Pro)", amount: 1500 },
  unlimited: { key: "unlimited", lookupKey: "atrium_unlimited_monthly", name: "Atrium Unlimited", amount: 3900, interval: "month" },
  pro: { key: "pro", lookupKey: "atrium_pro_monthly", name: "Atrium Pro", amount: 7900, interval: "month" },
};

/** Photoreal listings included in each month of Pro. */
export const PRO_PHOTOREAL_INCLUDED = 5;

export const PLAN_NAMES: Record<Plan, string> = { unlimited: "Unlimited", pro: "Pro" };

/**
 * A photoreal job waiting to be paid for, as the phone shows it. No price: the app doesn't sell
 * anything, payment happens on the website.
 */
export const PHOTOREAL_UNPAID = "The photos are in. Training starts once photoreal is turned on for this listing in the Atrium dashboard.";

/** What publishing a listing costs, as the Share panel shows it. */
export interface PublishPricing {
  /** "Publish tour — $19", "Publish tour — free". */
  label: string;
  note: string | null;
  /** Link to the plans. */
  plans: boolean;
}

/** What photoreal costs for a listing, as its panel shows it. */
export interface PhotorealPricing {
  note: string | null;
  /** Starting the waiting job sends the realtor to pay first. */
  pay: boolean;
  /** "Add photoreal — $20" when it has to be paid for. */
  payLabel: string;
}

/** "$19", "$19.50". */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}
