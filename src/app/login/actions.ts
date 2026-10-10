"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseAdminKey } from "@/lib/data/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AuthState {
  error?: string;
  notice?: string;
}

/** This site's own address, as the browser reached it (email links come back here). */
async function siteOrigin(): Promise<string | undefined> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : undefined;
}

export async function authAction(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  const mode = fd.get("mode") === "signup" ? "signup" : fd.get("mode") === "reset" ? "reset" : "signin";
  const next = String(fd.get("next") ?? "/dashboard");
  const supabase = await createSupabaseServerClient();
  if (mode === "reset") {
    if (!email) return { error: "Enter the email you signed up with." };
    // The emailed link lands on /auth/callback, which signs the realtor in and opens /reset-password.
    const origin = await siteOrigin();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: origin ? `${origin}/auth/callback?next=/reset-password` : undefined,
    });
    if (error && /rate|limit|security purposes/i.test(error.message)) {
      return { error: "A reset link was sent a moment ago. Wait a minute before asking for another." };
    }
    if (error) console.error("password reset:", error.message);
    // The same answer whether or not there's an account, so the form can't be used to find out.
    return { notice: "If there's an account for that email, a link to set a new password is on its way. Open it on this device." };
  }
  if (!email || password.length < 8) return { error: "Enter your email and a password of at least 8 characters." };
  if (mode === "signup" && supabaseAdminKey()) {
    // With the server's admin key the account is created already confirmed:
    // no confirmation email, no Supabase auth settings to change.
    const { error } = await createSupabaseAdminClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: String(fd.get("name") ?? "") },
    });
    if (error) {
      return { error: /already|exists|registered/i.test(error.message) ? "There's already an account with this email — sign in instead." : error.message };
    }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) return { error: signInError.message };
  } else if (mode === "signup") {
    // Confirmation emails land on /auth/callback, which signs the realtor in and opens the dashboard.
    const origin = await siteOrigin();
    const emailRedirectTo = origin ? `${origin}/auth/callback` : undefined;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: String(fd.get("name") ?? "") }, emailRedirectTo },
    });
    if (error) return { error: error.message };
    if (!data.session) return { notice: "Check your inbox and tap the confirmation link — it signs you in." };
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
  }
  redirect(next.startsWith("/dashboard") ? next : "/dashboard");
}

/** A new password for the signed-in realtor: after a reset link, or from the dashboard. */
export async function updatePasswordAction(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const password = String(fd.get("password") ?? "");
  if (password.length < 8) return { error: "Use at least 8 characters." };
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Your reset link has expired. Ask for a new one from the sign-in page." };
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: /different from the old/i.test(error.message) ? "Choose a password you haven't used here before." : error.message };
  }
  redirect("/dashboard?password=updated");
}
