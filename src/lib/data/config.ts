import path from "node:path";

// Supabase settings. Both naming schemes work: the legacy anon/service-role keys, and the
// publishable/secret keys that Vercel's Supabase integration injects automatically.
export function supabaseUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || undefined;
}

/** Browser-safe key (row-level security applies). */
export function supabasePublicKey(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || undefined;
}

/** Server-only key that bypasses row-level security (used for the iPhone upload endpoints). */
export function supabaseAdminKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || undefined;
}

export function isSupabaseConfigured(): boolean {
  return !!(supabaseUrl() && supabasePublicKey());
}

export const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "captures";

/**
 * Local mode keeps data in a JSON file + uploads folder. On read-only hosts
 * (e.g. Vercel without Supabase) we fall back to /tmp so the app still runs,
 * but data is ephemeral — configure Supabase for real deployments.
 */
export function localDataDir(): string {
  if (process.env.ATRIUM_DATA_DIR) return process.env.ATRIUM_DATA_DIR;
  if (process.env.VERCEL) return "/tmp/atrium-data";
  return path.join(process.cwd(), ".data");
}

export function storageMode(): "supabase" | "local" | "ephemeral" {
  if (isSupabaseConfigured()) return "supabase";
  return process.env.VERCEL && !process.env.ATRIUM_DATA_DIR ? "ephemeral" : "local";
}
