import type { Metadata } from "next";
import { FaqList } from "@/components/marketing/faq";
import { CtaBand, PageIntro, SiteFooter, SiteHeader } from "@/components/marketing/Site";

export const metadata: Metadata = {
  title: "FAQ",
  description: "What you need to scan a home with Atrium, how buyers view walkthroughs, how accurate the measurements are, and more.",
};

export default function Faq() {
  return (
    <div className="bg-paper text-ink">
      <SiteHeader />
      <PageIntro eyebrow="FAQ" title="Questions, answered." />
      <section className="mx-auto max-w-3xl px-5 pb-24 md:px-8">
        <FaqList />
      </section>
      <CtaBand />
      <SiteFooter />
    </div>
  );
}
