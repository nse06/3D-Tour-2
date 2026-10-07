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

export async function authAction(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  const mode = fd.get("mode") === "signup" ? "signup" : "signin";
  const next = String(fd.get("next") ?? "/dashboard");
  if (!email || password.length < 8) return { error: "Enter your email and a password of at least 8 characters." };
  const supabase = await createSupabaseServerClient();
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
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
    const emailRedirectTo = host ? `${proto}://${host}/auth/callback` : undefined;
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
