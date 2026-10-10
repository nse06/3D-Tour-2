import "server-only";

// Billing switches (docs/billing.md). Until STRIPE_SECRET_KEY is set, nothing is charged.

export function stripeSecretKey(): string | null {
  return process.env.STRIPE_SECRET_KEY?.trim() || null;
}

export function stripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

export function billingEnabled(): boolean {
  return !!stripeSecretKey();
}

/** Photoreal is free for founding agents during the beta; CHARGE_FOR_PHOTOREAL=true ends it. */
export function chargeForPhotoreal(): boolean {
  return billingEnabled() && /^(1|true|yes|on)$/i.test(process.env.CHARGE_FOR_PHOTOREAL?.trim() ?? "");
}

/**
 * Accounts that never pay: BILLING_EXEMPT_EMAILS, comma-separated addresses or whole domains
 * ("@example.com"). For the team and founding partners.
 */
export function isExemptEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const address = email.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@"));
  return (process.env.BILLING_EXEMPT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .some((e) => e && (e === address || (e.startsWith("@") && e === domain)));
}

export function exemptionsConfigured(): boolean {
  return !!process.env.BILLING_EXEMPT_EMAILS?.trim();
}

/**
 * A Stripe API stand-in on this machine (http://localhost:<port>), for automated tests only.
 * Anything else is ignored, so the secret key never goes anywhere but Stripe.
 */
export function stripeApiOverride(): { host: string; port: number; protocol: "http" } | null {
  const raw = process.env.STRIPE_API_BASE?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) return null;
    return { host: url.hostname, port: Number(url.port || 80), protocol: "http" };
  } catch {
    return null;
  }
}
