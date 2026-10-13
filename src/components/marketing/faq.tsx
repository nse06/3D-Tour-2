import Link from "next/link";
import type { ReactNode } from "react";

// Questions agents ask, shared by /faq and the home page. Keep the answers true to the product:
// measurements and square footage are approximate (src/lib/tour/measure.ts), Atrium Capture is in beta.

export interface Question {
  q: string;
  a: ReactNode;
  /** Shown on the home page too. */
  featured?: boolean;
}

export const QUESTIONS: Question[] = [
  {
    q: "What do I need to scan a home?",
    featured: true,
    a: (
      <>
        An iPhone with LiDAR — the iPhone 12 Pro or any newer Pro or Pro Max — and Atrium Capture, our free iPhone app (in beta: create an
        account and we&apos;ll get you access). No camera rig, tripod or photographer.
      </>
    ),
  },
  {
    q: "How does scanning work?",
    a: (
      <>
        Open Atrium Capture and walk the home slowly, room by room, pausing for a moment on each wall. The phone maps the rooms with LiDAR and
        takes photos on its own while it&apos;s steady. Lights on and doors open between rooms helps. Then send the scan to your listing from
        the app. <Link href="/how-it-works">See the full walkthrough</Link>.
      </>
    ),
  },
  {
    q: "How is this different from a 360° photo tour?",
    featured: true,
    a: (
      <>
        Photo tours let buyers hop between the spots where a camera stood. Atrium builds a 3D model of the home, so buyers walk anywhere —
        glide down a hallway, step up to a window, climb the stairs — and can measure things as they go.
      </>
    ),
  },
  {
    q: "What does AI enhancement do?",
    featured: true,
    a: (
      <>
        After the scan, a cloud GPU rebuilds the 3D model from all of the scan&apos;s photos at once: sharper walls and floors, even colors,
        TVs shown off, dark windows brightened and spots no photo saw filled in. It takes about 20 minutes, and you choose whether buyers see
        it or the original scan.
      </>
    ),
  },
  {
    q: "How do buyers view a walkthrough?",
    a: (
      <>
        With one link, in any browser, on a phone or a computer — no app and no account. Share it in texts and emails, on your website or
        social posts, or in your MLS&apos;s virtual tour field (check your MLS&apos;s rules for tour links).
      </>
    ),
  },
  {
    q: "How accurate are the room sizes and measurements?",
    featured: true,
    a: (
      <>
        Good for planning, not for contracts. LiDAR scans are typically within a few centimeters across a room and can drift a few percent
        along long walls, so every size in a walkthrough is marked approximate. The square footage shown is the scanned interior floor area,
        not an official (ANSI) measurement.
      </>
    ),
  },
  {
    q: "Does it handle homes with several floors?",
    a: <>Yes. Scan every floor in one session; the walkthrough connects them by the stairs and the floor plan has a tab for each level.</>,
  },
  {
    q: "What happens to the photos?",
    a: (
      <>
        They&apos;re used to build the walkthrough. Where photos show people, those parts are ignored. Once the walkthrough is done you can
        delete the photos from the listing&apos;s page in your dashboard.
      </>
    ),
  },
  {
    q: "What does it cost?",
    a: (
      <>
        Your first listing is free. After that you pay per listing or pick a monthly plan — <Link href="/pricing">see pricing</Link>.
      </>
    ),
  },
];

export function FaqList({ questions = QUESTIONS }: { questions?: Question[] }) {
  return (
    <div className="divide-y divide-sand border-y border-sand">
      {questions.map((item) => (
        <details key={item.q} className="group py-5">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-lg font-medium text-ink [&::-webkit-details-marker]:hidden">
            {item.q}
            <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-linen text-stone transition group-open:rotate-45">+</span>
          </summary>
          <div className="mt-3 max-w-3xl leading-relaxed text-neutral-600 [&_a]:text-ink [&_a]:underline [&_a]:underline-offset-2">{item.a}</div>
        </details>
      ))}
    </div>
  );
}
