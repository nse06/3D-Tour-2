import type { Metadata } from "next";
import { Footprints, Lightbulb, Link2, Send, Smartphone, WandSparkles } from "lucide-react";
import type { ReactNode } from "react";
import { CtaBand, Eyebrow, PageIntro, SiteFooter, SiteHeader } from "@/components/marketing/Site";

export const metadata: Metadata = {
  title: "How it works",
  description: "Scan a home with a LiDAR iPhone, let Atrium build and enhance the 3D walkthrough, and share it with one link.",
};

export default function HowItWorks() {
  return (
    <div className="bg-paper text-ink">
      <SiteHeader />
      <PageIntro eyebrow="How it works" title="From a walk through the home to a walkthrough buyers can explore.">
        No camera rig, no photographer, no 3D skills. If you can walk through a house with your phone, you can make an Atrium walkthrough.
      </PageIntro>

      <section className="mx-auto max-w-6xl px-5 pb-24 md:px-8">
        <ol className="space-y-6">
          <Stage n="01" icon={<Smartphone className="size-6" strokeWidth={1.4} />} title="Get ready">
            <p>
              You need an iPhone with LiDAR — the iPhone 12 Pro or any newer Pro or Pro Max — and Atrium Capture, our free iPhone app (in beta:
              create an account and we&apos;ll get you access). Create the listing in your dashboard and pair the app by scanning its QR code.
            </p>
          </Stage>
          <Stage n="02" icon={<Footprints className="size-6" strokeWidth={1.4} />} title="Scan the home">
            <p>
              Start a scan and walk the home slowly, room by room. The app maps walls, doors, windows, stairs and furniture with LiDAR, and takes
              photos on its own whenever the phone is steady. A coverage map shows what&apos;s still missing.
            </p>
            <Tips
              tips={[
                "Turn on the lights and open the doors between rooms.",
                "Move slowly along the walls and pause for a moment on each one.",
                "Walk between rooms with the phone up — that path becomes the tour route.",
                "Scan every floor in one session; the stairs connect them.",
              ]}
            />
          </Stage>
          <Stage n="03" icon={<Send className="size-6" strokeWidth={1.4} />} title="Send it to your listing">
            <p>
              The phone builds the 3D model right away. Send it to your listing, then tap <b className="font-semibold text-ink">Make it AI-enhanced</b>
              {" "}to upload the photos (a few hundred MB — best on Wi-Fi). Rooms, floors, the floor plan and the tour route are set up for you.
            </p>
          </Stage>
          <Stage n="04" icon={<WandSparkles className="size-6" strokeWidth={1.4} />} title="AI enhancement">
            <p>
              A cloud GPU rebuilds the model from all of the photos at once: sharper walls and floors, even colors, TVs shown off, dark windows
              brightened and spots no photo saw filled in. It takes about 20 minutes. Compare it with the original scan and choose what buyers
              see.
            </p>
          </Stage>
          <Stage n="05" icon={<Link2 className="size-6" strokeWidth={1.4} />} title="Publish and share">
            <p>
              Publish the listing and share its link anywhere: texts, email, your website, social posts, or your MLS&apos;s virtual tour field.
              Buyers open it in any browser and walk in — with the floor plan, room sizes and measuring tool at hand.
            </p>
          </Stage>
        </ol>
      </section>

      <section className="bg-white">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 md:grid-cols-3 md:px-8">
          <Fact eyebrow="Scan" value="One visit" text="The scan and its photos are captured together, in a single walk through the home." />
          <Fact eyebrow="AI enhancement" value="~20 min" text="On a cloud GPU after the photos are uploaded. You can close the app." />
          <Fact eyebrow="Viewing" value="Any browser" text="Phones and computers, no app or account for buyers." />
        </div>
      </section>

      <CtaBand />
      <SiteFooter />
    </div>
  );
}

function Stage({ n, icon, title, children }: { n: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="grid gap-6 rounded-3xl border border-sand bg-white p-8 shadow-[0_8px_28px_rgba(30,24,16,0.05)] md:grid-cols-[180px_1fr] md:p-10">
      <div className="flex items-center gap-4 md:flex-col md:items-start">
        <span className="grid size-12 place-items-center rounded-2xl bg-linen text-ink">{icon}</span>
        <span className="font-display text-3xl text-stone/60">{n}</span>
      </div>
      <div>
        <h2 className="font-display text-3xl md:text-4xl">{title}</h2>
        <div className="mt-3 space-y-4 text-lg leading-relaxed text-neutral-600">{children}</div>
      </div>
    </li>
  );
}

function Tips({ tips }: { tips: string[] }) {
  return (
    <ul className="space-y-2 rounded-2xl bg-paper p-5 text-base">
      {tips.map((t) => (
        <li key={t} className="flex gap-3">
          <Lightbulb className="mt-1 size-4 shrink-0 text-gold" />
          {t}
        </li>
      ))}
    </ul>
  );
}

function Fact({ eyebrow, value, text }: { eyebrow: string; value: string; text: string }) {
  return (
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <p className="font-display mt-3 text-5xl">{value}</p>
      <p className="mt-2 text-neutral-600">{text}</p>
    </div>
  );
}
