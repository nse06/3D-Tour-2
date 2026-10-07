import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdminKey, supabaseUrl } from "@/lib/data/config";

let admin: SupabaseClient | null = null;

/**
 * Service-role client for requests that carry no realtor session (the iPhone
 * app authenticates with a capture-session token instead). It bypasses RLS,
 * so callers must scope every query to the owning user themselves.
 * The key (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY) is server-only and never sent to the browser.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const key = supabaseAdminKey();
  if (!key) throw new Error("iPhone uploads need SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY).");
  admin ??= createClient(supabaseUrl()!, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return admin;
}
