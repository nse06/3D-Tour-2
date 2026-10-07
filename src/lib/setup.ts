// Deployment health: is there a database, and does it have Atrium's tables?
// Drives the guided /setup screen so a fresh Vercel deployment explains its
// remaining steps instead of failing on the first dashboard request.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { storageMode, supabasePublicKey, supabaseUrl } from "@/lib/data/config";

export type SetupStatus =
  | { ok: true }
  | { ok: false; reason: "no-database" }
  | { ok: false; reason: "missing-schema"; projectRef: string | null; missing: string[] }
  | { ok: false; reason: "unreachable"; message: string };

/** Tables each migration introduces, in migration order. */
const REQUIRED_TABLES = ["properties", "tours", "floors", "rooms", "capture_sessions"];

const MISSING_TABLE = /PGRST205|42P01|schema cache|does not exist/i;

export async function checkSetup(): Promise<SetupStatus> {
  const mode = storageMode();
  if (mode === "local") return { ok: true };
  if (mode === "ephemeral") return { ok: false, reason: "no-database" };

  // Anonymous client: RLS hides rows, but a missing table still errors.
  const db = createClient(supabaseUrl()!, supabasePublicKey()!, { auth: { persistSession: false } });
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    // A GET (not HEAD) so PostgREST's error body — e.g. PGRST205 "not in the schema cache" — comes back.
    const { error } = await db.from(table).select("id").limit(1);
    if (!error) continue;
    if (MISSING_TABLE.test(`${error.code} ${error.message}`)) missing.push(table);
    else return { ok: false, reason: "unreachable", message: error.message };
  }
  if (!missing.length) return { ok: true };
  return { ok: false, reason: "missing-schema", projectRef: projectRefFrom(supabaseUrl()), missing };
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
