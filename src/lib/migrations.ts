// Creates and upgrades Atrium's database schema on its own, so a fresh
// deployment needs no SQL pasted by hand. Vercel's Supabase integration gives
// the server a direct Postgres connection string; the SQL files in
// supabase/migrations are applied in order, each once, tracked in
// public.atrium_migrations. Every file is idempotent, so re-running is safe.

import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import postgres from "postgres";
import { SUPABASE_ROOT_CA } from "@/lib/supabase/root-ca";

/** Direct Postgres URL: Vercel's Supabase integration sets POSTGRES_URL_NON_POOLING. */
export function databaseUrl(): string | null {
  return process.env.POSTGRES_URL_NON_POOLING || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
}

/** Arbitrary key for pg_advisory_lock: one migration run at a time across all server instances. */
const LOCK_KEY = 7_172_026_101;

let running: Promise<string[]> | null = null;

/** Applies pending migrations; returns the files applied. Concurrent callers share one run. */
export function applyMigrations(): Promise<string[]> {
  running ??= migrate().finally(() => {
    running = null;
  });
  return running;
}

async function migrate(): Promise<string[]> {
  const url = databaseUrl();
  if (!url) throw new Error("This deployment has no database connection string (POSTGRES_URL_NON_POOLING).");
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  // A database on this machine (e.g. `supabase start`) speaks plain TCP.
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 5,
    onnotice: () => {},
    // Verify the server: Supabase's own CA plus the usual public ones.
    ssl: local ? false : { ca: [SUPABASE_ROOT_CA, ...tls.rootCertificates] },
  });
  const applied: string[] = [];
  try {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    await sql`create table if not exists public.atrium_migrations (name text primary key, applied_at timestamptz not null default now())`;
    // Not exposed through the API: RLS on, no policies.
    await sql`alter table public.atrium_migrations enable row level security`;
    const done = new Set((await sql<{ name: string }[]>`select name from public.atrium_migrations`).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const text = await fs.readFile(path.join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into public.atrium_migrations (name) values (${file}) on conflict do nothing`;
      });
      applied.push(file);
    }
    // Make the API see the new tables right away.
    if (applied.length) await sql`notify pgrst, 'reload schema'`;
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
  return applied;
}
