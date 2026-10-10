import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/data/config";
import { NewPasswordForm } from "./NewPasswordForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a new password" };

/** Where a reset email's link lands (signed in by /auth/callback), and "Change password" from the dashboard. */
export default async function ResetPasswordPage() {
  if (!isSupabaseConfigured()) redirect("/dashboard");
  const user = await getCurrentUser();
  return (
    <div className="flex min-h-screen flex-col justify-center bg-paper px-6 py-12 md:px-16">
      <div className="mx-auto w-full max-w-sm">
        <Link href="/">
          <Wordmark />
        </Link>
        <h1 className="font-display mt-10 text-5xl leading-tight">New password</h1>
        {user ? (
          <>
            <p className="mt-2 text-neutral-600">For {user.email ?? "your account"}. At least 8 characters.</p>
            <div className="mt-8">
              <NewPasswordForm />
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-neutral-600">This link has expired or was already used.</p>
            <Link href="/login?mode=reset" className="mt-8 inline-flex rounded-full bg-ink px-5 py-3 text-sm font-medium text-white hover:bg-ink/90">
              Ask for a new reset link
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
