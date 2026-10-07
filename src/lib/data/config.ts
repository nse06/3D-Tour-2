import path from "node:path";

export function isSupabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
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
