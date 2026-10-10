import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/data/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const OTP_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

/**
 * Landing point for Supabase email links (sign-up confirmation, password reset). Signs the
 * realtor in, then continues to the dashboard, or to /reset-password from a reset email.
 *
 * Two kinds of link arrive: `?code=` (Supabase's default templates; the code only works in the
 * browser that asked for the email) and `?token_hash=&type=` (templates pointed here, which
 * work from any device; see README.md, Password reset emails).
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = url.searchParams.get("next");
  const safeNext = next && (next.startsWith("/dashboard") || next === "/reset-password") ? next : "/dashboard";
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const recovery = type === "recovery" || safeNext === "/reset-password";
  const destination = new URL(type === "recovery" ? "/reset-password" : safeNext, url.origin);
  if (!isSupabaseConfigured() || (!code && !tokenHash)) return NextResponse.redirect(destination);

  const supabase = await createSupabaseServerClient();
  const { error } =
    tokenHash && type && OTP_TYPES.includes(type)
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : code
        ? await supabase.auth.exchangeCodeForSession(code)
        : { error: new Error("unknown link") };
  if (error) {
    const login = new URL("/login", url.origin);
    if (recovery) {
      login.searchParams.set("mode", "reset");
      login.searchParams.set(
        "error",
        "That reset link didn't work: it expired, was already used, or was opened in a different browser than the one that asked for it. Ask for a new one below.",
      );
    } else {
      login.searchParams.set("error", "Your sign-in link expired or was already used. Please sign in again.");
    }
    return NextResponse.redirect(login);
  }
  return NextResponse.redirect(destination);
}
