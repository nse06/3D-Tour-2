import { CheckCircle2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ContactBlock, LegalPage } from "@/components/marketing/Legal";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Deleting your account",
  description: "How to delete your Atrium account and everything in it, and what is kept afterwards.",
};

export default async function DeleteAccount(props: PageProps<"/legal/delete-account">) {
  const { deleted } = await props.searchParams;
  return (
    <LegalPage
      title="Deleting your account"
      intro={<>You can delete your Atrium account yourself at any time. It takes effect right away and can&apos;t be undone.</>}
    >
      {deleted === "1" && (
        <p className="flex items-start gap-3 rounded-2xl bg-emerald-50 p-4 text-emerald-900 ring-1 ring-emerald-200">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
          Your account and everything in it have been deleted.
        </p>
      )}

      <h2>How to delete it</h2>
      <ol>
        <li>
          Sign in and open <Link href="/dashboard/account">Account</Link> in the dashboard.
        </li>
        <li>
          Under <strong>Delete account</strong>, type DELETE and confirm.
        </li>
      </ol>
      <p>
        Can&apos;t sign in? Write to <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a> from the account&apos;s email address and we&apos;ll
        delete it within 30 days.
      </p>

      <h2>What&apos;s deleted</h2>
      <ul>
        <li>Your login, name and email address.</li>
        <li>Every listing, with its details, cover photo and published walkthrough (the links stop working).</li>
        <li>Every scan: 3D models, room layouts, LiDAR meshes, AI-enhanced models and the photos kept on our servers.</li>
        <li>Your plan: any subscription ends immediately, with no further charges.</li>
        <li>Your billing records in Atrium, and pairings with the Atrium Capture app.</li>
      </ul>

      <h2>What&apos;s kept</h2>
      <ul>
        <li>
          <strong>Payment records</strong> (invoices and payments) stay with our payment processor, Stripe, for as long as tax and accounting
          law requires.
        </li>
        <li>
          <strong>Backups and server logs</strong> held by our providers are deleted on their regular schedule.
        </li>
        <li>
          <strong>Scans on your iPhone</strong> stay on the phone: delete them in Atrium Capture, or delete the app.
        </li>
      </ul>
      <p>
        To delete just one listing, open it in the dashboard and choose <strong>Delete listing</strong>. To delete only the photos kept for AI
        enhancement, use <strong>Delete the photos</strong> in the listing&apos;s Remastered model card.
      </p>

      <h2>Questions</h2>
      <ContactBlock />
    </LegalPage>
  );
}
