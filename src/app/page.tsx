import { ArrowRight, Check, Footprints, Layers, Link2, MapIcon, PlayCircle, Ruler, Smartphone, WandSparkles, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { FaqList, QUESTIONS } from "@/components/marketing/faq";
import { CtaBand, Eyebrow, SiteFooter, SiteHeader } from "@/components/marketing/Site";

export default function Home() {
  return (
    <div className="bg-paper text-ink">
      {/* Hero */}
      <section className="relative min-h-[100svh] overflow-hidden bg-[#141210] text-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/demo/sheridan-road-cover.jpg"
          alt="Inside the 3D walkthrough of a sample home"
          className="absolute inset-0 size-full scale-[1.02] object-cover opacity-80"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/20 to-black/80" />
        <SiteHeader overlay />
        <div className="relative z-10 mx-auto flex max-w-6xl flex-col justify-end px-5 pb-16 pt-[18vh] md:px-8 md:pb-24">
          <p className="rise text-[12px] font-semibold uppercase tracking-[0.32em] text-white/70">3D walkthroughs for listings</p>
          <h1 className="rise font-display mt-5 max-w-4xl text-[46px] leading-[1.02] md:text-[88px]" style={{ animationDelay: "80ms" }}>
            Homes buyers can actually walk through.
          </h1>
          <p className="rise mt-6 max-w-2xl text-lg text-white/80 md:text-xl" style={{ animationDelay: "160ms" }}>
            Scan a listing with your iPhone in one visit. Atrium turns it into a free-roaming 3D walkthrough — floor plan, room sizes and a tape
            measure built in — that buyers open from a single link.
          </p>
          <div className="rise mt-10 flex flex-wrap gap-3" style={{ animationDelay: "240ms" }}>
            <Link
              href="/tour/sample"
              className="group inline-flex h-14 items-center gap-3 rounded-full bg-white pl-7 pr-2 text-[15px] font-medium text-ink shadow-xl transition hover:scale-[1.02]"
            >
              Walk through a sample home
              <span className="grid size-10 place-items-center rounded-full bg-ink text-white transition group-hover:translate-x-0.5">
                <ArrowRight className="size-4" />
              </span>
            </Link>
            <Link
              href="/login?mode=signup"
              className="inline-flex h-14 items-center rounded-full px-6 text-[15px] font-medium text-white ring-1 ring-white/40 backdrop-blur transition hover:bg-white/10"
            >
              Get started — first listing free
            </Link>
          </div>
        </div>
      </section>

      {/* Three steps */}
      <section className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="font-display mt-4 max-w-3xl text-5xl leading-[1.05] md:text-6xl">One walk through the home. A walkthrough buyers keep coming back to.</h2>
        <div className="mt-16 grid gap-6 md:grid-cols-3">
          <Step
            icon={<Smartphone className="size-6" strokeWidth={1.4} />}
            n="01"
            title="Scan"
            text="Walk the home with Atrium Capture on a LiDAR iPhone. It maps every room and floor and takes the photos on its own."
          />
          <Step
            icon={<WandSparkles className="size-6" strokeWidth={1.4} />}
            n="02"
            title="Enhance"
            text="Send the scan to your listing. A cloud GPU rebuilds the model from every photo in about 20 minutes: sharper, evenly lit, gaps filled."
          />
          <Step
            icon={<Link2 className="size-6" strokeWidth={1.4} />}
            n="03"
            title="Share"
            text="Publish and send one link. Buyers step inside from any phone or computer — no app, no account."
          />
        </div>
        <Link href="/how-it-works" className="mt-10 inline-flex items-center gap-2 text-sm font-medium text-ink underline-offset-4 hover:underline">
          See how scanning works <ArrowRight className="size-4" />
        </Link>
      </section>

      {/* Features */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
          <Eyebrow>Inside the walkthrough</Eyebrow>
          <h2 className="font-display mt-4 max-w-3xl text-5xl leading-[1.05]">Not a slideshow, and not hopping between dots.</h2>
          <div className="mt-14 grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={<Footprints className="size-5" />} title="Walk anywhere">
              Tap the floor to go there, drag to look around. Buyers move through the home the way they would in person.
            </Feature>
            <Feature icon={<Layers className="size-5" />} title="Every floor, connected">
              Climb the stairs to the next level. Each floor has its own tab on the floor plan.
            </Feature>
            <Feature icon={<MapIcon className="size-5" />} title="Floor plan with room sizes">
              A live plan shows where you are, which way you face, and each room&apos;s length and width.
            </Feature>
            <Feature icon={<Ruler className="size-5" />} title="A tape measure built in">
              Tap two points on anything — a wall, a window, a counter — to see the distance in feet and inches.
            </Feature>
            <Feature icon={<WandSparkles className="size-5" />} title="AI-enhanced, your call">
              Compare the AI-enhanced model with the original scan and choose which one buyers see.
            </Feature>
            <Feature icon={<PlayCircle className="size-5" />} title="Guided tour">
              One tap plays a calm walk through every room, for buyers who&apos;d rather sit back.
            </Feature>
          </div>
        </div>
      </section>

      {/* Will it fit */}
      <section className="mx-auto grid max-w-6xl items-center gap-14 px-5 py-24 md:grid-cols-2 md:px-8 md:py-32">
        <div>
          <Eyebrow>For buyers and renters</Eyebrow>
          <h2 className="font-display mt-4 text-5xl leading-[1.05]">&ldquo;Will my couch fit?&rdquo; Answered before the showing.</h2>
          <p className="mt-6 text-lg leading-relaxed text-neutral-600">
            Photos can&apos;t tell you whether a sectional clears the doorway or a queen bed leaves room for nightstands. In an Atrium walkthrough,
            buyers measure the wall, the window or the alcove themselves — and show up to the showing already sure.
          </p>
          <p className="mt-4 text-sm text-neutral-500">Measurements are approximate: LiDAR is typically good to a few centimeters across a room.</p>
        </div>
        <div className="rounded-[28px] border border-sand bg-white p-8 shadow-[0_8px_28px_rgba(30,24,16,0.06)]">
          <div className="flex items-center justify-between rounded-2xl bg-ink px-5 py-4 text-white">
            <span className="flex items-center gap-2 text-sm text-white/70">
              <Ruler className="size-4 text-gold-soft" /> Measured
            </span>
            <span className="font-display text-3xl tabular-nums">7′ 4″</span>
          </div>
          <dl className="mt-6 space-y-3 text-sm">
            {[
              ["Living room", "18′ 2″ × 13′ 6″"],
              ["Primary bedroom", "15′ 0″ × 11′ 9″"],
              ["Kitchen", "12′ 4″ × 10′ 1″"],
            ].map(([room, size]) => (
              <div key={room} className="flex justify-between border-b border-linen pb-3">
                <dt className="text-neutral-600">{room}</dt>
                <dd className="font-medium tabular-nums">{size}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-xs text-neutral-400">Illustration of the floor plan&apos;s room sizes and the measuring tool.</p>
        </div>
      </section>

      {/* Comparison */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
          <Eyebrow>Compared</Eyebrow>
          <h2 className="font-display mt-4 max-w-3xl text-5xl leading-[1.05]">More than a 360° photo tour, without the camera rig.</h2>
          <div className="mt-12 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-sand text-stone">
                  <th className="py-3 pr-4 font-medium" />
                  <th className="py-3 pr-4 font-medium">360° photo tours</th>
                  <th className="py-3 font-medium text-ink">Atrium</th>
                </tr>
              </thead>
              <tbody>
                <Row label="How buyers move" photo="Jump between camera spots" atrium="Walk anywhere" />
                <Row label="Equipment" photo="360° camera, often a photographer" atrium="Your iPhone (Pro, with LiDAR)" />
                <Row label="Room sizes on the floor plan" photo={false} atrium />
                <Row label="Measure walls, windows, furniture" photo={false} atrium />
                <Row label="AI-enhanced 3D model" photo={false} atrium />
                <Row label="Viewing" photo="A link" atrium="A link, any browser, no app" />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-28">
        <div className="grid items-center gap-10 rounded-[28px] bg-linen p-8 md:grid-cols-[1.4fr_1fr] md:p-14">
          <div>
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="font-display mt-3 text-4xl leading-tight md:text-5xl">Your first listing is free.</h2>
            <p className="mt-4 max-w-lg text-neutral-600">
              Then pay per listing, or pick a monthly plan if you list often. No contracts, no camera to buy.
            </p>
          </div>
          <div className="flex md:justify-end">
            <Link
              href="/pricing"
              className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-6 text-sm font-medium text-white transition hover:bg-ink/90"
            >
              See pricing <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-6xl px-5 pb-24 md:px-8 md:pb-32">
        <div className="grid gap-10 md:grid-cols-[1fr_2fr]">
          <div>
            <Eyebrow>Questions</Eyebrow>
            <h2 className="font-display mt-3 text-4xl leading-tight">What agents ask first.</h2>
            <Link href="/faq" className="mt-6 inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline">
              All questions <ArrowRight className="size-4" />
            </Link>
          </div>
          <FaqList questions={QUESTIONS.filter((q) => q.featured)} />
        </div>
      </section>

      <CtaBand />
      <SiteFooter />
    </div>
  );
}

function Step({ icon, n, title, text }: { icon: ReactNode; n: string; title: string; text: string }) {
  return (
    <div className="rounded-3xl border border-sand bg-white p-8 shadow-[0_8px_28px_rgba(30,24,16,0.05)]">
      <div className="flex items-center justify-between">
        <span className="grid size-12 place-items-center rounded-2xl bg-linen text-ink">{icon}</span>
        <span className="font-display text-3xl text-stone/60">{n}</span>
      </div>
      <h3 className="font-display mt-8 text-3xl">{title}</h3>
      <p className="mt-3 leading-relaxed text-neutral-600">{text}</p>
    </div>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div>
      <span className="grid size-11 place-items-center rounded-2xl bg-paper text-ink ring-1 ring-sand">{icon}</span>
      <p className="mt-5 text-lg font-medium text-ink">{title}</p>
      <p className="mt-1.5 leading-relaxed text-neutral-600">{children}</p>
    </div>
  );
}

function Row({ label, photo, atrium }: { label: string; photo: string | boolean; atrium: string | boolean }) {
  const cell = (v: string | boolean, strong: boolean) =>
    typeof v === "string" ? (
      <span className={strong ? "font-medium text-ink" : "text-neutral-600"}>{v}</span>
    ) : v ? (
      <Check className="size-5 text-emerald-600" aria-label="Yes" />
    ) : (
      <X className="size-5 text-neutral-300" aria-label="No" />
    );
  return (
    <tr className="border-b border-linen">
      <td className="py-4 pr-4 text-neutral-600">{label}</td>
      <td className="py-4 pr-4">{cell(photo, false)}</td>
      <td className="py-4">{cell(atrium, true)}</td>
    </tr>
  );
}

