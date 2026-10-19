import type { Metadata } from "next";
import Link from "next/link";
import { ContactBlock, LegalPage } from "@/components/marketing/Legal";
import { LEGAL, SUBPROCESSORS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Atrium collects, how it's used, who processes it, how long it's kept, and your rights in the US and the EU.",
};

// Keep this true to the product: no analytics or advertising trackers, sign-in cookies only, scans
// processed on our own cloud GPUs (lib/remaster.ts, lib/photoreal.ts), deletion in the dashboard.

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <>
          Atrium makes 3D walkthroughs of homes. This policy explains what personal data we collect from real estate agents who use Atrium and from people who
          view walkthroughs, what we do with it, and the choices and rights you have. We don&apos;t sell personal data, and we don&apos;t use advertising or
          analytics trackers.
        </>
      }
    >
      <h2>1. Who we are</h2>
      <p>
        {LEGAL.company} (&ldquo;Atrium&rdquo;, &ldquo;we&rdquo;) runs the Atrium website, walkthroughs and the Atrium Capture iPhone app. For agents&apos;
        accounts and our own operations we are the data controller. For the homes agents scan, the agent decides what to scan and publish; we process those
        scans to provide the service.
      </p>
      <ContactBlock />

      <h2>2. What we collect</h2>
      <h3>From agents (account holders)</h3>
      <ul>
        <li>
          <strong>Account details:</strong> your name, email address and password (stored only as a secure hash by our authentication provider).
        </li>
        <li>
          <strong>Listing details:</strong> what you enter for each listing — address, price, rooms, description, cover photo.
        </li>
        <li>
          <strong>Scans:</strong> what Atrium Capture records in a home and you send to us — the 3D model, the room layout (walls, doors, windows, furniture
          outlines), the LiDAR depth mesh, the photos taken while scanning, and where each photo was taken in the home.
        </li>
        <li>
          <strong>Billing:</strong> your Stripe customer and subscription identifiers, plan, and which listings were paid for and how. Card details go directly
          to Stripe; we never see or store them.
        </li>
        <li>
          <strong>Support messages</strong> you send us.
        </li>
      </ul>
      <h3>From people viewing walkthroughs</h3>
      <p>
        Viewing a walkthrough needs no account. Our hosting provider receives the technical data every website receives — IP address, browser and device type,
        the pages requested and when — and keeps it in short-lived server logs for security and reliability. We don&apos;t use this to profile visitors.
      </p>
      <h3>People and belongings in scans</h3>
      <p>
        Scans show the inside of a home, which can include personal belongings and, occasionally, people. When building walkthroughs we detect people in the
        photos and leave those parts out. The few photos sent for AI review (below) aren&apos;t edited, so a person in one would be visible to the reviewer,
        which is told to ignore people. Agents are responsible for having the owner&apos;s and occupants&apos; permission to scan and publish a home, and for
        removing anything sensitive (documents, photos of family, valuables) before scanning — see our <Link href="/legal/terms">Terms</Link>.
      </p>
      <h3>Cookies</h3>
      <p>
        We use only the cookies needed to keep you signed in to your agent account. Walkthrough viewers get no cookies from us. There are no advertising,
        analytics or social-media cookies, so we don&apos;t ask for cookie consent.
      </p>

      <h2>3. How we use it</h2>
      <ul>
        <li>To provide Atrium: build, enhance, store and show your walkthroughs; run your account; send sign-in and account emails.</li>
        <li>
          To process scans with AI: our cloud GPUs rebuild the 3D model from your scan&apos;s photos (see <Link href="/legal/ai">How we use AI</Link>), and
          Anthropic&apos;s Claude checks the result from a few of the photos. Your scans are used only for your own listings. We don&apos;t use them to train AI
          models for anyone else, Anthropic doesn&apos;t train its models on what it checks, and no other third-party AI service sees them.
        </li>
        <li>To bill you, prevent fraud, and keep the service secure.</li>
        <li>To answer your questions and fix problems you report.</li>
        <li>To meet legal obligations, such as tax and accounting records.</li>
      </ul>
      <p>
        <strong>Legal bases (EU/UK/EEA):</strong> performing our contract with you (running your account and listings), our legitimate interests (security,
        preventing abuse, improving reliability — balanced against your rights), legal obligations (billing records), and your consent where we ask for it.
      </p>

      <h2>4. Who we share it with</h2>
      <p>
        We share personal data only with service providers that process it for us under contract, and when the law requires it. When you publish a listing, its
        walkthrough and details are public to anyone with the link — that&apos;s the point of publishing.
      </p>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>What for</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          {SUBPROCESSORS.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td>{s.purpose}</td>
              <td>{s.location}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        We don&apos;t sell personal data or share it for cross-context behavioral advertising, as those terms are defined under California and other US state
        laws.
      </p>
      <p>
        <strong>International transfers:</strong> Atrium and its providers are in the United States. When we transfer personal data from the EU/EEA, UK or
        Switzerland, we rely on the EU–US Data Privacy Framework where a provider is certified, or on the European Commission&apos;s Standard Contractual
        Clauses.
      </p>

      <h2>5. How long we keep it</h2>
      <ul>
        <li>
          <strong>Account and listings:</strong> until you delete them. Deleting a listing deletes its walkthrough, models and photos; deleting your account
          deletes everything in it.
        </li>
        <li>
          <strong>Scan photos kept for AI enhancement:</strong> the latest set for each listing, until you delete them from the listing&apos;s page, delete the
          listing, or delete your account. Older sets are deleted automatically when new photos arrive.
        </li>
        <li>
          <strong>Billing records:</strong> payments and invoices are kept by Stripe for as long as tax and accounting law requires, even after you delete your
          account.
        </li>
        <li>
          <strong>Photos checked by the AI reviewer:</strong> up to eight photos per AI-enhanced model, with views of the model, are sent to Anthropic. It
          doesn&apos;t keep them beyond the limited period its commercial terms allow for safety and abuse monitoring, and doesn&apos;t train its models on
          them.
        </li>
        <li>
          <strong>Server logs and backups:</strong> kept by our providers for a limited period, then deleted on their schedule.
        </li>
      </ul>

      <h2>6. Your rights</h2>
      <p>Wherever you live, you can:</p>
      <ul>
        <li>see and correct your account and listing details in your dashboard;</li>
        <li>
          delete any listing, the photos kept for a listing, or your whole account yourself — see{" "}
          <Link href="/legal/delete-account">Deleting your account</Link>;
        </li>
        <li>ask us for a copy of your personal data, or ask any other question about it, by writing to {LEGAL.email}.</li>
      </ul>
      <h3>EU, EEA, UK and Switzerland</h3>
      <p>
        Under the GDPR you have the right to access, rectify and erase your personal data, to restrict or object to its processing, to data portability, and to
        withdraw consent at any time. You may also complain to your local data protection authority.
      </p>
      <h3>California and other US states</h3>
      <p>
        Residents of California, Virginia, Colorado, Connecticut, Utah, Texas, Oregon and other states with privacy laws have the right to know what personal
        data we collect and how we use it, to access, correct and delete it, and to opt out of its sale, sharing for targeted advertising, or profiling — which
        we don&apos;t do. We won&apos;t treat you differently for using these rights. You can use an authorized agent; we&apos;ll verify requests by confirming
        control of the account&apos;s email address. If we decline a request, you can appeal by replying to our answer.
      </p>
      <p>We answer requests within 30 days (45 days where US state law allows), and tell you if we need longer.</p>

      <h2>7. Children</h2>
      <p>Atrium is a tool for real estate professionals and isn&apos;t directed to children. We don&apos;t knowingly collect data from anyone under 16.</p>

      <h2>8. Security</h2>
      <p>
        Data is encrypted in transit, access to it is limited to what each part of the service needs, and photos are reached only through short-lived signed
        links. No system is perfectly secure; if a breach affects your data, we&apos;ll tell you as the law requires.
      </p>

      <h2>9. Changes</h2>
      <p>If we change this policy, we&apos;ll update the date above, and for material changes we&apos;ll email account holders before they take effect.</p>

      <h2>10. Contact</h2>
      <ContactBlock />
    </LegalPage>
  );
}
