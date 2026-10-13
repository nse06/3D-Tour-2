import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { storageMode } from "@/lib/data/config";
import { DeleteAccountForm } from "./DeleteAccountForm";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();
  const mode = storageMode();
  return (
    <div className="mx-auto max-w-3xl px-5 py-10 md:px-8 md:py-14">
      <h1 className="font-display text-5xl">Account</h1>
      <Card className="mt-8 p-6 md:p-8">
        <p className="text-sm text-neutral-500">Signed in as</p>
        <p className="mt-1 text-lg font-medium">{user.name}</p>
        {user.email && <p className="text-neutral-600">{user.email}</p>}
        {mode === "supabase" && (
          <Link href="/reset-password" className="mt-4 inline-block text-sm font-medium underline underline-offset-2">
            Change password
          </Link>
        )}
      </Card>
      <Card className="mt-6 p-6 md:p-8">
        <h2 className="font-display text-3xl">Your data</h2>
        <p className="mt-2 text-neutral-600">
          Read how we handle it in the <Link href="/legal/privacy" className="underline underline-offset-2">Privacy Policy</Link> and{" "}
          <Link href="/legal/ai" className="underline underline-offset-2">How we use AI</Link>. For a copy of your data, write to us from this
          account&apos;s email address.
        </p>
      </Card>
      <Card className="mt-6 border-red-200 p-6 md:p-8">
        <h2 className="font-display text-3xl text-red-800">Delete account</h2>
        <p className="mt-2 text-neutral-600">
          Deletes your login, every listing and walkthrough, all scans and photos, and ends any subscription now. It can&apos;t be undone.{" "}
          <Link href="/legal/delete-account" className="underline underline-offset-2">What&apos;s deleted and what&apos;s kept</Link>.
        </p>
        <DeleteAccountForm />
      </Card>
    </div>
  );
}
