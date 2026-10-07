import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/data/config";
import type { AppUser } from "@/lib/data/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Local mode has a single implicit realtor so the MVP runs with zero setup.
 * With Supabase configured, realtors sign in with email + password.
 */
export const LOCAL_USER: AppUser = { id: "00000000-0000-4000-8000-000000000001", email: null, name: "Demo Realtor" };

export async function getCurrentUser(): Promise<AppUser | null> {
  if (!isSupabaseConfigured()) return LOCAL_USER;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const meta = data.user.user_metadata as { full_name?: string } | undefined;
  return { id: data.user.id, email: data.user.email ?? null, name: meta?.full_name || data.user.email?.split("@")[0] || "Realtor" };
}

export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
