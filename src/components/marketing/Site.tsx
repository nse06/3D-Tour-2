import { ArrowRight, Menu } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/ui";

// The public site's frame: header, footer and the pieces the marketing pages share.

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/faq", label: "FAQ" },
  { href: "/tour/sample", label: "Sample tour" },
];

/** `overlay`: light text over the hero photo; otherwise ink on paper. */
export function SiteHeader({ overlay = false }: { overlay?: boolean }) {
  const text = overlay ? "text-white" : "text-ink";
  const muted = overlay ? "text-white/80 hover:text-white" : "text-neutral-600 hover:text-ink";
  return (
    <header className={`relative z-20 mx-auto flex max-w-6xl items-center justify-between px-5 py-6 md:px-8 ${text}`}>
      <Link href="/" aria-label="Atrium home">
        <Wordmark className={text} />
      </Link>
      <nav className="hidden items-center gap-1 text-sm md:flex">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`rounded-full px-3 py-1.5 ${muted}`}>
            {n.label}
          </Link>
        ))}
        <Link href="/dashboard" className={`rounded-full px-3 py-1.5 ${muted}`}>
          Sign in
        </Link>
        <Link
          href="/login?mode=signup"
          className={
            overlay
              ? "ml-2 rounded-full bg-white px-4 py-2 font-medium text-ink hover:bg-white/90"
              : "ml-2 rounded-full bg-ink px-4 py-2 font-medium text-white hover:bg-ink/90"
          }
        >
          Get started
        </Link>
      </nav>
      {/* Phones: a plain disclosure menu, no script needed. */}
      <details className="group relative md:hidden">
        <summary
          className={`grid size-10 cursor-pointer list-none place-items-center rounded-full ring-1 [&::-webkit-details-marker]:hidden ${overlay ? "ring-white/40" : "ring-sand"}`}
          aria-label="Menu"
        >
          <Menu className="size-5" />
        </summary>
        <div className="absolute right-0 mt-2 w-56 rounded-2xl bg-white p-2 text-ink shadow-xl ring-1 ring-sand">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="block rounded-xl px-3 py-2.5 text-sm hover:bg-paper">
              {n.label}
            </Link>
          ))}
          <Link href="/dashboard" className="block rounded-xl px-3 py-2.5 text-sm hover:bg-paper">
            Sign in
          </Link>
          <Link href="/login?mode=signup" className="mt-1 block rounded-xl bg-ink px-3 py-2.5 text-center text-sm font-medium text-white">
            Get started
          </Link>
        </div>
      </details>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-sand bg-paper">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 text-sm md:grid-cols-[1.5fr_1fr_1fr_1fr] md:px-8">
        <div>
          <Wordmark className="text-ink" />
          <p className="mt-3 max-w-xs text-neutral-600">Free-roaming 3D walkthroughs of homes, scanned with an iPhone in one visit.</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-ink">Product</p>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="block text-neutral-600 hover:text-ink">
              {n.label}
            </Link>
          ))}
        </div>
        <div className="space-y-2">
          <p className="font-medium text-ink">Account</p>
          <Link href="/login?mode=signup" className="block text-neutral-600 hover:text-ink">
            Create an account
          </Link>
          <Link href="/dashboard" className="block text-neutral-600 hover:text-ink">
            Agent dashboard
          </Link>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-ink">Legal</p>
          {[
            ["/legal/privacy", "Privacy Policy"],
            ["/legal/terms", "Terms of Service"],
            ["/legal/ai", "How we use AI"],
            ["/legal/delete-account", "Deleting your account"],
          ].map(([href, label]) => (
            <Link key={href} href={href} className="block text-neutral-600 hover:text-ink">
              {label}
            </Link>
          ))}
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-5 pb-10 text-xs text-neutral-500 md:px-8">
        © {new Date().getFullYear()} Atrium. The sample home is fictional. Sizes and measurements in walkthroughs are approximate.
      </div>
    </footer>
  );
}

/** Small uppercase label above a section heading. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[12px] font-semibold uppercase tracking-[0.28em] text-stone ${className}`}>{children}</p>;
}

/** The plain page top for pages without a photo hero. */
export function PageIntro({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl px-5 pb-12 pt-10 md:px-8 md:pb-16 md:pt-16">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="font-display mt-4 max-w-4xl text-5xl leading-[1.03] md:text-7xl">{title}</h1>
      {children && <div className="mt-6 max-w-2xl text-lg text-neutral-600">{children}</div>}
    </section>
  );
}

/** The closing call to action every marketing page ends with. */
export function CtaBand({ title = "Scan your next listing this week.", text }: { title?: string; text?: string }) {
  return (
    <section className="bg-ink text-white">
      <div className="mx-auto max-w-6xl px-5 py-20 text-center md:px-8 md:py-28">
        <h2 className="font-display mx-auto max-w-3xl text-5xl leading-[1.05] md:text-6xl">{title}</h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-white/70">
          {text ?? "Create a free account, scan the home with your iPhone, and share the walkthrough the same day."}
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link
            href="/login?mode=signup"
            className="group inline-flex h-14 items-center gap-3 rounded-full bg-white pl-7 pr-2 text-[15px] font-medium text-ink transition hover:scale-[1.02]"
          >
            Get started free
            <span className="grid size-10 place-items-center rounded-full bg-ink text-white transition group-hover:translate-x-0.5">
              <ArrowRight className="size-4" />
            </span>
          </Link>
          <Link
            href="/tour/sample"
            className="inline-flex h-14 items-center rounded-full px-6 text-[15px] font-medium text-white ring-1 ring-white/30 transition hover:bg-white/10"
          >
            Walk through a sample home
          </Link>
        </div>
      </div>
    </section>
  );
}
