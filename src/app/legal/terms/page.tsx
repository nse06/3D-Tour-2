import type { Metadata } from "next";
import Link from "next/link";
import { ContactBlock, LegalPage } from "@/components/marketing/Legal";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms for using Atrium: accounts, scanning homes, AI-enhanced walkthroughs, billing, and our responsibilities.",
};

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <>
          These terms are an agreement between you and {LEGAL.company} for using the Atrium website, walkthroughs and the Atrium Capture app.
          By creating an account or using Atrium, you agree to them. If you use Atrium for a brokerage or company, you agree for it too.
        </>
      }
    >
      <h2>1. Using Atrium</h2>
      <p>
        Atrium is for real estate professionals and property owners, for making and sharing walkthroughs of properties. You must be at least
        18 and able to enter a contract. Keep your password secure; you&apos;re responsible for what happens in your account. People viewing
        a walkthrough don&apos;t need an account, and these terms apply to them only as far as they use the site.
      </p>

      <h2>2. Scanning homes: your responsibilities</h2>
      <p>When you scan, upload or publish a property, you confirm that:</p>
      <ul>
        <li>you have the right to do so — the owner&apos;s permission and, where someone lives there, the occupants&apos; permission;</li>
        <li>
          you&apos;ve removed or kept out of the scan anything private: people, documents, photos of family, security systems and
          valuables;
        </li>
        <li>
          your listing and its walkthrough comply with the laws and rules that apply to you, including fair housing law, advertising and
          licensing rules, and your MLS&apos;s rules — including any rule on disclosing images that were altered or enhanced (see{" "}
          <Link href="/legal/ai">How we use AI</Link>);
        </li>
        <li>nothing you upload infringes anyone&apos;s rights or is unlawful.</li>
      </ul>
      <p>Don&apos;t misuse Atrium: no attempts to break into the service, overload it, scrape it, or use it to mislead buyers.</p>

      <h2>3. Your content</h2>
      <p>
        You keep ownership of your scans, photos and listing details. You give us a worldwide, non-exclusive license to host, process,
        enhance, display and share them as needed to provide Atrium to you — for example, to build the AI-enhanced model and to show a
        published walkthrough to anyone with its link. This license ends when you delete the content, except for copies in backups that
        expire on schedule. We may show a published walkthrough as an example of Atrium only with your permission.
      </p>

      <h2>4. Measurements, room sizes and AI enhancement</h2>
      <p>
        Room sizes, square footage and distances measured in a walkthrough come from the phone&apos;s scan and are{" "}
        <strong>approximate</strong>. They&apos;re for planning only — not for appraisals, legal descriptions, pricing by size or any official
        (ANSI or local) square footage. AI-enhanced models are reconstructions: they can sharpen, relight and fill in parts of a home the photos
        didn&apos;t show, and may contain inaccuracies. Check what buyers will see before you publish; you choose whether buyers see the
        original scan or the AI-enhanced model.
      </p>

      <h2>5. Plans, payment and cancellation</h2>
      <ul>
        <li>
          Prices are on our <Link href="/pricing">pricing page</Link> and shown before you pay. Payments are processed by Stripe; taxes may
          apply.
        </li>
        <li>
          A listing paid for once stays paid for. Monthly plans renew each month until cancelled; you can cancel any time in Billing, and the
          plan ends at the end of the period you&apos;ve paid for. Listings published on a plan stay live after it ends.
        </li>
        <li>
          Except where the law requires otherwise, payments aren&apos;t refundable. If something didn&apos;t work, write to us — we&apos;ll
          make it right where we reasonably can.
        </li>
        <li>We may change prices for the future with at least 30 days&apos; notice to subscribers; current periods aren&apos;t affected.</li>
      </ul>

      <h2>6. Availability and changes</h2>
      <p>
        We work to keep Atrium available but can&apos;t promise it will be uninterrupted or error-free. Features marked beta may change or be
        withdrawn. We may update these terms; for material changes we&apos;ll give account holders notice by email before they take effect.
        Continuing to use Atrium afterwards means you accept the new terms.
      </p>

      <h2>7. Ending your use</h2>
      <p>
        You can delete your account any time (see <Link href="/legal/delete-account">Deleting your account</Link>). We may suspend or close
        accounts that break these terms or the law, with notice where reasonable. Sections 3 (as to backups), 4, 8, 9 and 10 survive.
      </p>

      <h2>8. Disclaimers</h2>
      <p>
        Atrium is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law allows, we disclaim all warranties,
        express or implied, including merchantability, fitness for a particular purpose and non-infringement. We don&apos;t verify listings
        and aren&apos;t a party to any real estate transaction.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the extent the law allows, we aren&apos;t liable for indirect, incidental, special, consequential or punitive damages, or for lost
        profits, revenue, data or business, and our total liability for any claim relating to Atrium is limited to the greater of what you
        paid us in the 12 months before the claim and US$100. Nothing in these terms limits liability that can&apos;t be limited by law,
        such as for fraud, or for death or personal injury caused by negligence.
      </p>
      <p>
        You&apos;ll indemnify us against third-party claims arising from content you upload or publish, or from your breach of section 2.
      </p>

      <h2>10. Law and disputes</h2>
      <p>
        These terms are governed by the laws of the State of {LEGAL.governingLaw}, USA, without regard to conflict-of-law rules, and disputes
        go to the state or federal courts located there. If you&apos;re a consumer in the EU, EEA, UK or Switzerland, you keep the protection
        of the mandatory laws of your country and can bring claims in your local courts.
      </p>

      <h2>11. Contact and legal notice</h2>
      <ContactBlock />
    </LegalPage>
  );
}
