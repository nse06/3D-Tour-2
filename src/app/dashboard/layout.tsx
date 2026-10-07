import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { storageMode } from "@/lib/data/config";
import { signOutAction } from "./actions";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const mode = storageMode();
  // Without a database this host can't keep listings or uploads: /setup explains how to connect one.
  if (mode === "ephemeral") redirect("/setup");
  const user = await requireUser();
  const initials = user.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-30 border-b border-sand/70 bg-paper/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5 md:px-8">
          <Link href="/dashboard" className="flex items-baseline gap-2">
            <Wordmark />
            <span className="hidden text-[11px] font-semibold uppercase tracking-[0.2em] text-stone sm:inline">for agents</span>
          </Link>
          <nav className="hidden items-center gap-1 text-sm md:flex">
            <Link href="/dashboard" className="rounded-full px-3 py-1.5 font-medium text-ink hover:bg-black/5">
              Listings
            </Link>
            <Link href="/tour/sample" target="_blank" className="rounded-full px-3 py-1.5 text-neutral-500 hover:bg-black/5 hover:text-ink">
              Sample tour
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {mode === "local" && (
              <span
                className="hidden rounded-full bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200 sm:inline"
                title="Listings are stored locally in .data/. Configure Supabase for production."
              >
                Local demo mode
              </span>
            )}
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 place-items-center rounded-full bg-ink text-xs font-semibold text-white">{initials}</span>
              <span className="hidden text-sm font-medium md:inline">{user.name}</span>
            </div>
            {mode === "supabase" && (
              <form action={signOutAction}>
                <button className="rounded-full px-3 py-1.5 text-sm text-neutral-500 hover:bg-black/5 hover:text-ink">Sign out</button>
              </form>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 pb-24 pt-10 md:px-8">{children}</main>
    </div>
  );
}
