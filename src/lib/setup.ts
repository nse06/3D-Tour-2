// Deployment health: is there a database, and does it have Atrium's tables?
// Drives the guided /setup screen so a fresh Vercel deployment explains its
// remaining steps instead of failing on the first dashboard request.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { storageMode, supabasePublicKey, supabaseUrl } from "@/lib/data/config";
import { applyMigrations, databaseUrl } from "@/lib/migrations";

export type SetupStatus =
  | { ok: true }
  | { ok: false; reason: "no-database" }
  | { ok: false; reason: "missing-schema"; projectRef: string | null; missing: string[]; autoSetupError: string | null }
  | { ok: false; reason: "unreachable"; message: string };

/** Tables each migration introduces, in migration order. */
const REQUIRED_TABLES = ["properties", "tours", "floors", "rooms", "capture_sessions", "photoreal_jobs", "billing_grants"];
/** Columns later migrations add to existing tables (a missing one also triggers the setup). */
const REQUIRED_COLUMNS: [table: string, column: string][] = [
  ["tours", "clean_asset_url"],
  ["tours", "splat_url"],
];

const MISSING_TABLE = /PGRST205|42P01|schema cache|does not exist/i;

export async function checkSetup(): Promise<SetupStatus> {
  const mode = storageMode();
  if (mode === "local") return { ok: true };
  if (mode === "ephemeral") return { ok: false, reason: "no-database" };

  // Anonymous client: RLS hides rows, but a missing table still errors.
  const db = createClient(supabaseUrl()!, supabasePublicKey()!, { auth: { persistSession: false } });
  let found = await missingTables(db);
  if ("unreachable" in found) return { ok: false, reason: "unreachable", message: found.unreachable };
  if (!found.missing.length) return { ok: true };

  // Create the tables ourselves when this deployment can reach Postgres directly
  // (Vercel's Supabase integration provides the connection string).
  let autoSetupError: string | null = null;
  if (databaseUrl()) {
    try {
      await applyMigrations();
      // The API reloads its schema cache asynchronously; give it a moment.
      for (let attempt = 0; attempt < 8; attempt++) {
        found = await missingTables(db);
        if ("unreachable" in found || !found.missing.length) break;
        await new Promise((r) => setTimeout(r, 750));
      }
      if ("unreachable" in found) return { ok: false, reason: "unreachable", message: found.unreachable };
      if (!found.missing.length) return { ok: true };
    } catch (e) {
      autoSetupError = redact((e as Error).message);
      console.error("automatic database setup failed:", autoSetupError);
    }
  }
  return {
    ok: false,
    reason: "missing-schema",
    projectRef: projectRefFrom(supabaseUrl()),
    missing: "missing" in found ? found.missing : REQUIRED_TABLES,
    autoSetupError,
  };
}

async function missingTables(db: SupabaseClient): Promise<{ missing: string[] } | { unreachable: string }> {
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    // A GET (not HEAD) so PostgREST's error body — e.g. PGRST205 "not in the schema cache" — comes back.
    const { error } = await db.from(table).select("id").limit(1);
    if (!error) continue;
    if (MISSING_TABLE.test(`${error.code} ${error.message}`)) missing.push(table);
    else return { unreachable: error.message };
  }
  for (const [table, column] of REQUIRED_COLUMNS) {
    if (missing.includes(table)) continue;
    const { error } = await db.from(table).select(column).limit(1);
    if (!error) continue;
    if (MISSING_TABLE.test(`${error.code} ${error.message}`)) missing.push(`${table}.${column}`);
    else return { unreachable: error.message };
  }
  return { missing };
}

/** Error text without anything that looks like a connection string. */
function redact(message: string): string {
  return message.replace(/postgres(ql)?:\/\/\S+/gi, "postgres://…");
}

export function isMissingSchemaError(e: unknown): boolean {
  return e instanceof Error && MISSING_TABLE.test(e.message);
}

function projectRefFrom(url: string | undefined): string | null {
  const m = url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

/** All SQL migrations concatenated in order (run once on a fresh project), or null if the files aren't bundled. */
export async function migrationsSql(): Promise<string | null> {
  try {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const parts = await Promise.all(files.map(async (f) => `-- ${f}\n${(await fs.readFile(path.join(dir, f), "utf8")).trim()}\n`));
    return parts.join("\n");
  } catch {
    return null;
  }
}

/** Where the migrations live in the deployed Git repository (Vercel exposes these variables at runtime). */
export function migrationsSourceUrl(): string | null {
  const { VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: slug, VERCEL_GIT_COMMIT_REF: ref } = process.env;
  return owner && slug && ref ? `https://github.com/${owner}/${slug}/tree/${ref}/supabase/migrations` : null;
}
