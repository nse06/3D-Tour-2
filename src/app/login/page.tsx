import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/data/config";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  if (!isSupabaseConfigured()) redirect("/dashboard");
  if (await getCurrentUser()) redirect("/dashboard");
  const { next, error } = await props.searchParams;
  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <div className="relative hidden md:block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/demo/sheridan-road-cover.jpg" alt="" className="absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/20" />
        <p className="font-display absolute bottom-10 left-10 right-10 text-4xl leading-tight text-white">
          &ldquo;My buyers could actually walk through the house remotely.&rdquo;
        </p>
      </div>
      <div className="flex flex-col justify-center bg-paper px-6 py-12 md:px-16">
        <Link href="/">
          <Wordmark />
        </Link>
        <h1 className="font-display mt-10 text-5xl leading-tight">Welcome back</h1>
        <p className="mt-2 text-neutral-600">Sign in to manage your 3D listings.</p>
        {typeof error === "string" && <p className="mt-4 max-w-sm rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
        <div className="mt-8 max-w-sm">
          <LoginForm next={typeof next === "string" ? next : "/dashboard"} />
        </div>
      </div>
    </div>
  );
}
