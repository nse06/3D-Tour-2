# Billing

Atrium charges realtors with Stripe. Payment always happens on the website, on Stripe's own pages. The
iPhone app never shows a price or sells anything: it's a free companion to the website, the way App Store
rule 3.1.3(f) expects.

## 1. Plans

| Plan | Price | Publishing listings | Photoreal walkthroughs |
| --- | --- | --- | --- |
| **Pay per listing** (default) | $19 per listing, the realtor's first listing free | pay once, when the listing goes live | $20 per listing |
| **Unlimited** | $39/month | every listing | $20 per listing |
| **Pro** | $79/month | every listing | 5 listings a month included, then $15 each |

* **Photoreal is free for founding agents during the beta.** Until `CHARGE_FOR_PHOTOREAL=true` is set,
  nobody pays for it. Listings made photoreal during the beta keep it: retraining them stays free afterwards.
* **A listing paid for once stays paid for.** Unpublishing and republishing, rescanning, and retraining photoreal
  cost nothing more.
* **Listings published on a plan stay live when the plan ends.** Ending a plan only stops covering new listings.
* **Exempt accounts** (`BILLING_EXEMPT_EMAILS`, for the team and founding partners) never pay.
* Promotion codes created in Stripe work at checkout (for discounts to founding agents, say).

Amounts live in `src/lib/billing/plans.ts`. Stripe prices are found by lookup key (`atrium_listing`,
`atrium_photoreal`, `atrium_photoreal_pro`, `atrium_unlimited_monthly`, `atrium_pro_monthly`) and created on first
use, with their products. After changing an amount in code, the next checkout creates a new price and moves the
lookup key to it. Existing subscriptions keep their old price until they're moved in Stripe.

## 2. How it works

**Publishing.** **Publish** on a listing's page shows what it costs: *Publish tour — free* (the first listing),
*Publish tour* with "Included in your Unlimited plan", or *Publish tour — $19*. A paid listing goes to Stripe
Checkout. Afterwards Stripe sends the realtor back to `/api/billing/return`, which records the payment and
publishes the listing.

**Photoreal.** The phone uploads the photos as before. If photoreal has to be paid for, the job waits in
`queued`. The phone says "Training starts once photoreal is turned on for this listing in the Atrium dashboard".
The listing page offers **Add photoreal — $20** (or $15 on Pro), and paying starts the training.

**Plans.** **Plans & billing** (`/dashboard/billing`, linked from the dashboard's top bar) shows the plans, the
current one, Pro's photoreal count for the month, and a history of what each listing was paid with. **Manage
billing** opens Stripe's customer portal, where realtors switch between Unlimited and Pro (prorated), cancel (at
the end of the period), change cards and download invoices. A realtor already on a plan who picks the other plan
is sent to the portal too, so nobody ends up with two subscriptions.

**Records.** Every way a listing gets covered is a *grant*, recorded once with a unique reference:

| Grant source | When |
| --- | --- |
| `purchase` | A Checkout payment (the reference is the Checkout Session id). |
| `free` | The realtor's first listing (reference `free:<user>`: one per realtor, even if that listing is deleted later). |
| `subscription` | Published while on Unlimited or Pro. |
| `pro_quota` | Photoreal included in Pro (counted per billing period). |
| `exempt` | An exempt account. |
| `beta` | Photoreal during the beta. |
| `unbilled` | Published or made photoreal while billing was off, or live when charging started. |

Two paths report a finished checkout: the return page, right away, and the webhook (`checkout.session.completed`,
or `checkout.session.async_payment_succeeded` for bank debits, which clear days later). Both record the same grant
once, and only the first one publishes the listing or starts the training. Subscription changes
(`customer.subscription.*`) are fetched fresh from Stripe, because webhook events can arrive out of order.

**Database (Supabase).** Migration `20261012000000_billing.sql` adds `billing_customers`, `billing_subscriptions` and
`billing_grants` (plus `billing_settings`). Realtors can read their own rows. Only the server writes them, with the
service-role key. Once charging starts, a trigger refuses to publish a listing that has no grant when the request
comes with a realtor's own session. Without it, a realtor could flip `published` with direct API calls. At that
moment every listing already live gets an `unbilled` grant, so it keeps its link and can be republished free. Local
mode keeps the same records in `.data/billing.json`.

## 3. Set it up

1. In the [Stripe dashboard](https://dashboard.stripe.com) (start in **test mode**), copy the **secret key**.
2. **Developers → Webhooks → Add endpoint**:
   * URL: `https://<your site>/api/stripe/webhook`
   * Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
     `customer.subscription.paused`, `customer.subscription.resumed`

   Then copy its **signing secret** (`whsec_…`).
3. In Vercel (**Settings → Environment Variables**), add:
   * `STRIPE_SECRET_KEY`: the secret key (`sk_test_…` while testing, `sk_live_…` for real payments)
   * `STRIPE_WEBHOOK_SECRET`: the signing secret
   * `BILLING_EXEMPT_EMAILS` (optional): `you@example.com, @yourbrokerage.com`
   * `CHARGE_FOR_PHOTOREAL=true`: only when the photoreal beta ends

   Then redeploy. Keys go into the environment variables, never into code or chat. The secret key stays on the
   server: no `NEXT_PUBLIC_` prefix.
4. Open **Plans & billing** in the dashboard. The products and prices appear in Stripe on the first checkout, and
   the customer-portal settings on the first **Manage billing**. To test, pay with card `4242 4242 4242 4242`, any
   future date and any CVC.
5. For live payments, repeat steps 1–3 with live-mode keys and a live-mode webhook.

Without `STRIPE_SECRET_KEY`, billing is off and everything is free, as before. With Supabase, billing needs the
service-role key (`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`), the same one the iPhone uploads use. The
database tables are created on first use, like the others (or paste the migration from `/setup`).

The webhook is what makes payments reliable. The return page covers a realtor who comes straight back, but a
closed tab, a bank debit or a plan change in the portal only reaches the site through the webhook.

## 4. Develop and test

* `STRIPE_API_BASE=http://localhost:<port>` points the server at a local stand-in for Stripe's API (only
  `localhost` addresses are accepted, so the secret key can't be sent anywhere else). The end-to-end checks for
  this feature ran that way, with a headless browser:
  * Billing on: first listing free, $19 checkout, a webhook replay, a bad signature, backing out of checkout,
    another realtor's checkout, the portal, subscribing, plan coverage, cancelling, a bank debit, photoreal at
    $20 and $15 on Pro, the phone's waiting job.
  * Billing off, and on during the beta.
  * Supabase: the migration and the publish guard against Postgres 16 and PostgREST.
* [Stripe CLI](https://docs.stripe.com/stripe-cli): `stripe listen --forward-to localhost:3000/api/stripe/webhook`
  prints a `whsec_…` for local webhooks.

## 5. Limits

* A refund doesn't unpublish anything. Unpublish the listing by hand if needed.
* Prices are in US dollars, without tax collection (Stripe Tax can be turned on later).
* "Per listing" is per listing record. A realtor could edit a paid listing into a different home; the history on
  **Plans & billing** shows which listings were paid for.
