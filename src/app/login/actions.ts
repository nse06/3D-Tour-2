"use server";

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
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: String(fd.get("name") ?? "") } } });
    if (error) return { error: error.message };
    if (!data.session) return { notice: "Check your inbox to confirm your email, then sign in." };
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
  }
  redirect(next.startsWith("/dashboard") ? next : "/dashboard");
}
