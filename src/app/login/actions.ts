"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
  if (mode === "signup") {
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
