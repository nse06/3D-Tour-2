import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL } from "@/lib/legal";
import { SiteFooter, SiteHeader } from "./Site";

export const LEGAL_PAGES = [
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/terms", label: "Terms of Service" },
  { href: "/legal/ai", label: "How we use AI" },
  { href: "/legal/delete-account", label: "Deleting your account" },
];

/** A legal document: title, effective date, the other documents alongside, readable prose. */
export function LegalPage({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-paper text-ink">
      <SiteHeader />
      <div className="mx-auto grid max-w-6xl gap-12 px-5 pb-24 pt-10 md:grid-cols-[220px_1fr] md:px-8 md:pt-16">
        <nav aria-label="Legal" className="order-2 md:order-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.28em] text-stone">Legal</p>
          <ul className="mt-4 space-y-2 text-sm">
            {LEGAL_PAGES.map((p) => (
              <li key={p.href}>
                <Link href={p.href} className="text-neutral-600 hover:text-ink">
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className="order-1 max-w-3xl md:order-2">
          <h1 className="font-display text-5xl leading-[1.05] md:text-6xl">{title}</h1>
          <p className="mt-4 text-sm text-neutral-500">Effective {LEGAL.effective}</p>
          {intro && <div className="mt-6 text-lg leading-relaxed text-neutral-700">{intro}</div>}
          <div
            className="mt-10 space-y-5 leading-relaxed text-neutral-700 [&_a]:text-ink [&_a]:underline [&_a]:underline-offset-2 [&_h2]:font-display [&_h2]:pt-6 [&_h2]:text-3xl [&_h2]:text-ink [&_h3]:pt-2 [&_h3]:font-semibold [&_h3]:text-ink [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_strong]:text-ink [&_table]:w-full [&_table]:text-left [&_table]:text-sm [&_td]:border-b [&_td]:border-linen [&_td]:py-2.5 [&_td]:pr-4 [&_td]:align-top [&_th]:border-b [&_th]:border-sand [&_th]:py-2 [&_th]:pr-4 [&_th]:font-medium [&_th]:text-stone [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6"
          >
            {children}
          </div>
        </article>
      </div>
      <SiteFooter />
    </div>
  );
}

/** How to reach us, as every document ends. */
export function ContactBlock() {
  return (
    <p>
      {LEGAL.company}
      {LEGAL.address ? `, ${LEGAL.address}` : ""} · <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>
    </p>
  );
}
