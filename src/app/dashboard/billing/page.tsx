import { Check, Sparkles } from "lucide-react";
import { ManageBillingButton, PlanButton } from "@/components/dashboard/BillingButtons";
import { Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { activePlan, proPhotorealUsed } from "@/lib/billing/access";
import { billingEnabled, chargeForPhotoreal, isExemptEmail } from "@/lib/billing/config";
import { dollars, PLAN_NAMES, PRICES, PRO_PHOTOREAL_INCLUDED, type Plan } from "@/lib/billing/plans";
import { getBillingStore, type Grant } from "@/lib/billing/store";
import { getRepository } from "@/lib/data/repository";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing" };

const HOW: Record<Grant["source"], string> = {
  purchase: "Paid",
  subscription: "Included in your plan",
  free: "Free (first listing)",
  pro_quota: "Included in Pro",
  exempt: "Complimentary",
  beta: "Free during the beta",
  unbilled: "Before billing started",
};

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

export default async function BillingPage(props: PageProps<"/dashboard/billing">) {
  const user = await requireUser();
  const { subscribed, error } = await props.searchParams;

  if (!billingEnabled()) {
    return (
      <div className="rise max-w-2xl">
        <p className="text-[12px] font-semibold uppercase tracking-[0.24em] text-stone">Billing</p>
        <h1 className="font-display mt-2 text-5xl leading-[1.05] text-ink">Plans &amp; billing</h1>
        <Card className="mt-8 p-6 text-sm text-neutral-600">
          Billing is off on this site, so publishing and photoreal cost nothing. To start charging, add <code>STRIPE_SECRET_KEY</code> and{" "}
          <code>STRIPE_WEBHOOK_SECRET</code> to the server&apos;s environment variables (README.md, Billing).
        </Card>
      </div>
    );
  }

  const store = await getBillingStore();
  const [plan, grants, customer, listings] = await Promise.all([
    activePlan(user.id),
    store.grants(user.id),
    store.customerId(user.id),
    getRepository().then((repo) => repo.listProperties(user.id)),
  ]);
  const proUsed = plan?.plan === "pro" ? await proPhotorealUsed(user.id, plan) : 0;
  const exempt = isExemptEmail(user.email);
  const photorealBeta = !chargeForPhotoreal();
  const freeListingLeft = !grants.some((g) => g.kind === "listing" && g.source === "free");
  const addresses = new Map(listings.map((l) => [l.property.id, l.property.addressLine]));
  const photorealLine = photorealBeta ? "Photoreal free during the beta" : `Photoreal ${dollars(PRICES.photoreal.amount)} per listing`;

  const cards: { id: "listing" | Plan; name: string; price: string; per: string; features: string[] }[] = [
    {
      id: "listing",
      name: "Pay per listing",
      price: dollars(PRICES.listing.amount),
      per: "per listing",
      features: [freeListingLeft ? "Your first listing is free" : "Pay once, when a listing goes live", "Republish and rescan at no charge", photorealLine],
    },
    {
      id: "unlimited",
      name: PLAN_NAMES.unlimited,
      price: dollars(PRICES.unlimited.amount),
      per: "per month",
      features: ["Publish every listing", "Republish and rescan at no charge", photorealLine],
    },
    {
      id: "pro",
      name: PLAN_NAMES.pro,
      price: dollars(PRICES.pro.amount),
      per: "per month",
      features: [
        "Publish every listing",
        `${PRO_PHOTOREAL_INCLUDED} photoreal listings a month`,
        `Then ${dollars(PRICES.photorealPro.amount)} per photoreal listing`,
      ],
    },
  ];
  const current = plan?.plan ?? "listing";

  return (
    <div className="rise">
      {subscribed && (
        <p className="mb-8 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {plan ? `You're on ${PLAN_NAMES[plan.plan]}. Thank you!` : "Thank you! Your plan starts as soon as Stripe confirms the payment."}
        </p>
      )}
      {error && (
        <p className="mb-8 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          We couldn&apos;t confirm that payment just now. If you were charged, it shows up here within a few minutes.
        </p>
      )}
      <p className="text-[12px] font-semibold uppercase tracking-[0.24em] text-stone">Billing</p>
      <h1 className="font-display mt-2 text-5xl leading-[1.05] text-ink">Plans &amp; billing</h1>

      <Card className="mt-8 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">Your plan</p>
          <p className="mt-1 text-lg font-medium text-ink">
            {exempt
              ? "Complimentary"
              : plan
                ? `${PLAN_NAMES[plan.plan]} · ${dollars(PRICES[plan.plan].amount)}/month`
                : `Pay per listing · ${dollars(PRICES.listing.amount)} a listing`}
          </p>
          <p className="text-sm text-neutral-500">
            {exempt
              ? "Publishing and photoreal cost nothing on this account."
              : plan
                ? plan.status === "past_due"
                  ? "The last payment didn't go through. Stripe is trying again; update your card in Manage billing."
                  : plan.cancelAtPeriodEnd
                    ? `Ends ${day(plan.currentPeriodEnd)}. Listings already live stay live.`
                    : `Renews ${day(plan.currentPeriodEnd)}.`
                : freeListingLeft
                  ? "Your first listing is on us."
                  : "You pay once per listing, when it goes live."}
            {plan?.plan === "pro" && !photorealBeta && ` ${proUsed} of ${PRO_PHOTOREAL_INCLUDED} photoreal listings used this month.`}
          </p>
        </div>
        {customer && <ManageBillingButton />}
      </Card>

      {photorealBeta && (
        <p className="mt-4 flex items-center gap-2 text-sm text-neutral-600">
          <Sparkles className="size-4 text-gold" /> Photoreal walkthroughs are free for founding agents during the beta.
        </p>
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {cards.map((c) => {
          const isCurrent = !exempt && c.id === current;
          return (
            <Card key={c.id} className={`flex flex-col p-6 ${isCurrent ? "ring-2 ring-ink" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-ink">{c.name}</p>
                {isCurrent && <span className="rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-semibold text-white">Current</span>}
              </div>
              <p className="mt-3">
                <span className="font-display text-4xl text-ink">{c.price}</span> <span className="text-sm text-neutral-500">{c.per}</span>
              </p>
              <ul className="mt-5 flex-1 space-y-2 text-sm text-neutral-600">
                {c.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" /> {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                {!exempt && c.id !== "listing" && !isCurrent && (
                  <PlanButton plan={c.id} label={plan ? `Switch to ${c.name}` : `Choose ${c.name}`} primary={c.id === "pro"} />
                )}
                {!exempt && c.id === "listing" && plan && <p className="text-xs text-neutral-500">Cancel your plan in Manage billing to go back.</p>}
              </div>
            </Card>
          );
        })}
      </div>

      <h2 className="font-display mt-14 text-3xl text-ink">History</h2>
      {grants.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">Nothing yet. Listings you publish and make photoreal show up here.</p>
      ) : (
        <Card className="mt-4 divide-y divide-sand/70">
          {grants.slice(0, 100).map((g) => (
            <div key={g.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-6 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{(g.propertyId && addresses.get(g.propertyId)) || "A deleted listing"}</span>
              <span className="w-28 text-neutral-500">{g.kind === "listing" ? "Published" : "Photoreal"}</span>
              <span className="w-44 text-neutral-500">{g.source === "purchase" ? `Paid ${dollars(g.amountCents)}` : HOW[g.source]}</span>
              <span className="w-28 text-right text-neutral-400">{day(g.createdAt)}</span>
            </div>
          ))}
        </Card>
      )}
      {customer && <p className="mt-3 text-xs text-neutral-400">Receipts and invoices are in Manage billing.</p>}
    </div>
  );
}
