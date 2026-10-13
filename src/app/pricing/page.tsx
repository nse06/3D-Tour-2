import type { Metadata } from "next";
import { Check } from "lucide-react";
import Link from "next/link";
import { FaqList, QUESTIONS } from "@/components/marketing/faq";
import { CtaBand, PageIntro, SiteFooter, SiteHeader } from "@/components/marketing/Site";
import { chargeForPhotoreal } from "@/lib/billing/config";
import { dollars, PRICES, PRO_PHOTOREAL_INCLUDED } from "@/lib/billing/plans";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Your first Atrium listing is free. Then pay per listing or choose a monthly plan.",
};

// Prices come from src/lib/billing/plans.ts, the same amounts checkout charges (docs/billing.md). AI
// enhancement is billed as the listing's "photoreal" purchase: one look made from the scan's photos.

export default function Pricing() {
  const aiFree = !chargeForPhotoreal();
  const ai = aiFree ? "Free during the beta" : `${dollars(PRICES.photoreal.amount)} per listing`;
  const plans = [
    {
      name: "Pay per listing",
      price: dollars(PRICES.listing.amount),
      cadence: "per listing",
      blurb: "For agents with a listing now and then.",
      features: [
        "Your first listing free",
        "Pay once, when the walkthrough goes live",
        "Floor plan, room sizes and measuring tool",
        `AI enhancement: ${aiFree ? "free during the beta" : `${dollars(PRICES.photoreal.amount)} per listing`}`,
      ],
      cta: "Start free",
      highlight: false,
    },
    {
      name: "Unlimited",
      price: dollars(PRICES.unlimited.amount),
      cadence: "per month",
      blurb: "For agents who list every month.",
      features: [
        "Publish every listing",
        "Listings stay live if you cancel",
        "Floor plan, room sizes and measuring tool",
        `AI enhancement: ${aiFree ? "free during the beta" : `${dollars(PRICES.photoreal.amount)} per listing`}`,
      ],
      cta: "Choose Unlimited",
      highlight: true,
    },
    {
      name: "Pro",
      price: dollars(PRICES.pro.amount),
      cadence: "per month",
      blurb: "For busy agents and small teams.",
      features: [
        "Publish every listing",
        aiFree
          ? "AI enhancement: free during the beta"
          : `${PRO_PHOTOREAL_INCLUDED} AI-enhanced listings a month, then ${dollars(PRICES.photorealPro.amount)} each`,
        "Listings stay live if you cancel",
        "Floor plan, room sizes and measuring tool",
      ],
      cta: "Choose Pro",
      highlight: false,
    },
  ];

  return (
    <div className="bg-paper text-ink">
      <SiteHeader />
      <PageIntro eyebrow="Pricing" title="Simple pricing. Your first listing is free.">
        No camera to buy and no contract. Pay per listing, or choose a monthly plan if you list often — and change or cancel any time.
      </PageIntro>

      <section className="mx-auto max-w-6xl px-5 pb-12 md:px-8">
        <div className="grid gap-6 md:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`flex flex-col rounded-3xl p-8 ${
                p.highlight ? "bg-ink text-white shadow-2xl" : "border border-sand bg-white shadow-[0_8px_28px_rgba(30,24,16,0.05)]"
              }`}
            >
              <p className={`text-sm font-medium ${p.highlight ? "text-gold-soft" : "text-stone"}`}>{p.name}</p>
              <p className="mt-4 flex items-baseline gap-2">
                <span className="font-display text-6xl">{p.price}</span>
                <span className={p.highlight ? "text-white/60" : "text-neutral-500"}>{p.cadence}</span>
              </p>
              <p className={`mt-2 ${p.highlight ? "text-white/70" : "text-neutral-600"}`}>{p.blurb}</p>
              <ul className="mt-8 flex-1 space-y-3 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-3">
                    <Check className={`mt-0.5 size-4 shrink-0 ${p.highlight ? "text-gold-soft" : "text-emerald-600"}`} />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/login?mode=signup"
                className={`mt-10 inline-flex h-12 items-center justify-center rounded-full text-sm font-medium transition ${
                  p.highlight ? "bg-white text-ink hover:bg-white/90" : "bg-ink text-white hover:bg-ink/90"
                }`}
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-neutral-500">
          AI enhancement: {ai}. Prices in US dollars. A listing paid for once stays paid for: rescanning, unpublishing and republishing cost
          nothing more.
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-5 py-20 md:px-8">
        <h2 className="font-display text-4xl">Pricing questions</h2>
        <div className="mt-8">
          <FaqList
            questions={[
              {
                q: "What counts as a listing?",
                a: <>One property. Scan it again, rescan a room or unpublish and republish it as often as you need — it&apos;s paid for once.</>,
              },
              {
                q: "What happens to my walkthroughs if I cancel a plan?",
                a: <>Listings published while you were on a plan stay live. Cancelling only stops covering new listings.</>,
              },
              {
                q: "Do buyers pay anything?",
                a: <>No. Buyers open the walkthrough from its link for free, with no app or account.</>,
              },
              ...QUESTIONS.filter((q) => q.q.startsWith("What does AI enhancement")),
            ]}
          />
        </div>
      </section>

      <CtaBand title="Try it on your next listing — free." />
      <SiteFooter />
    </div>
  );
}
