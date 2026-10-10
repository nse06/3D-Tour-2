import type Stripe from "stripe";
import { billingEnabled, stripeWebhookSecret } from "@/lib/billing/config";
import { handleStripeEvent, stripe } from "@/lib/billing/stripe";
import { serverBaseUrl } from "@/lib/capture-sessions";

/**
 * Stripe's notifications (docs/billing.md): finished checkouts, including bank payments that clear
 * days later, and plan changes and cancellations made in Stripe's billing portal. Configure the
 * endpoint https://<site>/api/stripe/webhook in Stripe and STRIPE_WEBHOOK_SECRET here.
 */
export async function POST(request: Request) {
  const secret = stripeWebhookSecret();
  if (!billingEnabled() || !secret) return Response.json({ error: "Billing isn't set up on this server." }, { status: 503 });
  // The signature covers the exact bytes Stripe sent.
  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(payload, request.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return Response.json({ error: "Invalid signature." }, { status: 400 });
  }
  try {
    await handleStripeEvent(event, serverBaseUrl(request.headers).url);
  } catch (e) {
    // Stripe retries failed deliveries for days; every handler is safe to run again.
    console.error(`stripe webhook ${event.type} (${event.id}):`, (e as Error).message);
    return Response.json({ error: "Couldn't process the event." }, { status: 500 });
  }
  return Response.json({ received: true });
}
