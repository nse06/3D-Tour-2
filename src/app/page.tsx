import { ArrowRight, Box, Layers, Link2, MapIcon, MousePointerClick, ScanLine, Smartphone } from "lucide-react";
import Link from "next/link";
import { ButtonLink, Wordmark } from "@/components/ui";

export default function Home() {
  return (
    <div className="bg-paper text-ink">
      {/* Hero */}
      <section className="relative min-h-[100svh] overflow-hidden bg-[#141210] text-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/demo/sheridan-road-cover.jpg"
          alt="Inside the 3D walkthrough of 1234 Sheridan Road"
          className="absolute inset-0 size-full scale-[1.02] object-cover opacity-80"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/20 to-black/75" />
        <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-6 md:px-8">
          <Wordmark className="text-white" />
          <nav className="flex items-center gap-1 text-sm">
            <a href="#how" className="hidden rounded-full px-3 py-1.5 text-white/80 hover:text-white sm:inline">
              How it works
            </a>
            <Link href="/tour/sample" className="hidden rounded-full px-3 py-1.5 text-white/80 hover:text-white sm:inline">
              Sample tour
            </Link>
            <Link
              href="/dashboard"
              className="ml-2 rounded-full bg-white/15 px-4 py-2 font-medium text-white ring-1 ring-white/25 backdrop-blur hover:bg-white/25"
            >
              Agent dashboard
            </Link>
          </nav>
        </header>
        <div className="relative z-10 mx-auto flex max-w-6xl flex-col justify-end px-5 pb-16 pt-[22vh] md:px-8 md:pb-24">
          <p className="rise text-[12px] font-semibold uppercase tracking-[0.32em] text-white/70">Immersive 3D property tours</p>
          <h1 className="rise font-display mt-5 max-w-4xl text-[44px] leading-[1.02] md:text-[84px]" style={{ animationDelay: "80ms" }}>
            Walk through a property with your phone once.
          </h1>
          <p className="rise mt-6 max-w-2xl text-lg text-white/80 md:text-xl" style={{ animationDelay: "160ms" }}>
            Turn it into a 3D walkthrough that buyers can explore from anywhere — room by room, floor by floor, from a single link.
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
              href="/dashboard"
              className="inline-flex h-14 items-center rounded-full px-6 text-[15px] font-medium text-white ring-1 ring-white/40 backdrop-blur transition hover:bg-white/10"
            >
              Create a listing
            </Link>
          </div>
          <p className="mt-10 text-sm text-white/60">1234 Sheridan Road · Wilmette, IL · 5 beds · 4.5 baths · 4,200 sq ft</p>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
        <p className="text-[12px] font-semibold uppercase tracking-[0.28em] text-stone">How it works</p>
        <h2 className="font-display mt-4 max-w-3xl text-5xl leading-[1.05] md:text-6xl">From one walkthrough to a home buyers can explore.</h2>
        <div className="mt-16 grid gap-6 md:grid-cols-3">
          <Step
            icon={<Smartphone className="size-6" strokeWidth={1.4} />}
            n="01"
            title="Capture"
            text="Walk the home with your iPhone. LiDAR and RoomPlan map every room and floor while the camera records the path you take."
            note="iPhone app in development — upload a 3D model today."
          />
          <Step
            icon={<ScanLine className="size-6" strokeWidth={1.4} />}
            n="02"
            title="We build the walkthrough"
            text="The capture becomes a 3D model with rooms, floors, a floor plan and a guided path — no 3D modeling or setup on your end."
          />
          <Step
            icon={<Link2 className="size-6" strokeWidth={1.4} />}
            n="03"
            title="Share one link"
            text="Publish and send the link. Buyers open it in any browser and step inside — no app, no account."
          />
        </div>
      </section>

      {/* What buyers get */}
      <section className="bg-white">
        <div className="mx-auto grid max-w-6xl items-center gap-16 px-5 py-24 md:grid-cols-2 md:px-8 md:py-32">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.28em] text-stone">Not a slideshow</p>
            <h2 className="font-display mt-4 text-5xl leading-[1.05]">Buyers move through the home — not past photos of it.</h2>
            <ul className="mt-10 space-y-6">
              <Feature
                icon={<MousePointerClick className="size-5" />}
                title="Walk naturally"
                text="Glide room to room, look in every direction, and step anywhere by tapping the floor."
              />
              <Feature
                icon={<Layers className="size-5" />}
                title="Every floor, connected"
                text="Climb the stairs to the next level the way you would in person."
              />
              <Feature
                icon={<MapIcon className="size-5" />}
                title="Always oriented"
                text="A live floor plan shows where you are and which way you're facing."
              />
              <Feature
                icon={<Box className="size-5" />}
                title="Built for real scans"
                text="The same viewer will play iPhone LiDAR captures automatically when the capture app launches."
              />
            </ul>
          </div>
          <Link href="/tour/sample" className="group relative block overflow-hidden rounded-[28px] shadow-2xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/demo/sheridan-road-cover.jpg"
              alt=""
              className="aspect-[4/5] w-full object-cover transition duration-700 group-hover:scale-[1.03] md:aspect-[4/5]"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent" />
            <div className="absolute inset-x-6 bottom-6 flex items-end justify-between text-white">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/70">Sample walkthrough</p>
                <p className="font-display mt-1 text-3xl">1234 Sheridan Road</p>
              </div>
              <span className="grid size-12 place-items-center rounded-full bg-white text-ink transition group-hover:translate-x-1">
                <ArrowRight className="size-5" />
              </span>
            </div>
          </Link>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-5 py-24 text-center md:px-8 md:py-32">
        <h2 className="font-display mx-auto max-w-3xl text-5xl leading-[1.05] md:text-6xl">Give every buyer a private showing.</h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-neutral-600">Create a listing, attach its 3D capture, and share the walkthrough in minutes.</p>
        <div className="mt-10 flex justify-center gap-3">
          <ButtonLink href="/dashboard" size="lg">
            Open the agent dashboard <ArrowRight className="size-4" />
          </ButtonLink>
          <ButtonLink href="/tour/sample" size="lg" variant="secondary">
            View sample
          </ButtonLink>
        </div>
      </section>

      <footer className="border-t border-sand">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-sm text-neutral-500 md:flex-row md:px-8">
          <Wordmark className="text-ink" />
          <p>The demo property is fictional. © {new Date().getFullYear()} Atrium.</p>
        </div>
      </footer>
    </div>
  );
}

function Step({ icon, n, title, text, note }: { icon: React.ReactNode; n: string; title: string; text: string; note?: string }) {
  return (
    <div className="rounded-3xl border border-sand bg-white p-8 shadow-[0_8px_28px_rgba(30,24,16,0.05)]">
      <div className="flex items-center justify-between">
        <span className="grid size-12 place-items-center rounded-2xl bg-linen text-ink">{icon}</span>
        <span className="font-display text-3xl text-stone/60">{n}</span>
      </div>
      <h3 className="font-display mt-8 text-3xl">{title}</h3>
      <p className="mt-3 leading-relaxed text-neutral-600">{text}</p>
      {note && <p className="mt-4 inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200">{note}</p>}
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <li className="flex gap-4">
      <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-paper text-ink ring-1 ring-sand">{icon}</span>
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-neutral-600">{text}</p>
      </div>
    </li>
  );
}
