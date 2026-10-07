import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/data/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Landing point for Supabase email links (sign-up confirmation, magic links).
 * Exchanges the one-time code for a session cookie, then continues to the dashboard.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = url.searchParams.get("next");
  const destination = new URL(next && next.startsWith("/dashboard") ? next : "/dashboard", url.origin);
  const code = url.searchParams.get("code");
  if (!isSupabaseConfigured() || !code) return NextResponse.redirect(destination);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const login = new URL("/login", url.origin);
    login.searchParams.set("error", "Your sign-in link expired or was already used. Please sign in again.");
    return NextResponse.redirect(login);
  }
  return NextResponse.redirect(destination);
}
