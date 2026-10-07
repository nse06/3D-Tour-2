// Asset storage for 3D captures, cover photos and iPhone scan packages.
//
// Clients upload directly (PUT) to a short-lived signed URL so large scans
// never pass through a serverless function body:
//  - local mode:    /api/uploads/<key>?exp&sig  → .data/uploads/<key>, served by /api/assets/<key>
//  - Supabase mode: Storage signed upload URL   → public bucket URL
//
// Keys are always <userId>/<propertyId>/<kind>-<uuid>.<ext>, which lets the
// server verify that a submitted asset URL really belongs to the property.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, localDataDir, SUPABASE_BUCKET, supabasePublicKey, supabaseUrl } from "./data/config";

export type UploadKind = "capture" | "cover" | "package";

export const UPLOAD_RULES: Record<UploadKind, { extensions: string[]; maxBytes: number }> = {
  capture: { extensions: ["glb", "gltf"], maxBytes: 250 * 1024 * 1024 },
  cover: { extensions: ["jpg", "jpeg", "png", "webp"], maxBytes: 12 * 1024 * 1024 },
  // iPhone scan package: scan.json, RoomPlan data and RGB keyframes (docs/iphone-capture.md §3.3).
  package: { extensions: ["zip"], maxBytes: 1024 * 1024 * 1024 },
};

export const CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  zip: "application/zip",
};

export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  assetUrl: string;
}

/** A rejected upload request; `status` is the HTTP status to answer with. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

let cachedSecret: string | null = null;

/** Signing secret shared by every route/process that touches the local data dir. */
function uploadSecret(): string {
  if (process.env.ATRIUM_UPLOAD_SECRET) return process.env.ATRIUM_UPLOAD_SECRET;
  if (cachedSecret) return cachedSecret;
  const file = path.join(localDataDir(), "upload-secret");
  try {
    cachedSecret = readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(localDataDir(), { recursive: true });
    cachedSecret = randomBytes(32).toString("hex");
    writeFileSync(file, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

function sign(key: string, exp: number) {
  return createHmac("sha256", uploadSecret()).update(`${key}:${exp}`).digest("hex");
}

export function verifyLocalUpload(key: string, exp: string | null, sig: string | null): boolean {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(key, Number(exp)));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Keys must stay inside the uploads folder. */
export function safeKey(parts: string[]): string | null {
  if (!parts.length || parts.some((p) => !p || p === "." || p === ".." || !/^[\w.-]+$/.test(p))) return null;
  return parts.join("/");
}

export function localUploadPath(key: string): string {
  return path.join(localDataDir(), "uploads", ...key.split("/"));
}

export function extensionOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

const KEY_FILE = /^(capture|cover|package)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]+)$/;

/** The kind of a storage key ("<userId>/<propertyId>/<kind>-<uuid>.<ext>"), or null if it isn't a valid key. */
export function uploadKindOfKey(key: string): UploadKind | null {
  const parts = key.split("/");
  const match = parts.length === 3 ? KEY_FILE.exec(parts[2]) : null;
  if (!match) return null;
  const kind = match[1] as UploadKind;
  return UPLOAD_RULES[kind].extensions.includes(match[2]) ? kind : null;
}

function sizeLabel(bytes: number) {
  return bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Prepare a direct-to-storage upload. `admin` signs Supabase upload URLs with
 * the service role, for callers without a realtor session (the iPhone app);
 * the key still lives in the realtor's own folder.
 */
export async function createUploadTarget(
  userId: string,
  propertyId: string,
  kind: UploadKind,
  filename: string,
  size: number,
  options: { admin?: boolean } = {},
): Promise<UploadTarget> {
  const ext = extensionOf(filename);
  const rules = UPLOAD_RULES[kind];
  if (!rules.extensions.includes(ext)) throw new UploadError(`Please choose a ${rules.extensions.map((e) => "." + e).join(" or ")} file.`);
  if (!Number.isFinite(size) || !(size > 0)) throw new UploadError("The file is empty.");
  if (size > rules.maxBytes) throw new UploadError(`Files must be smaller than ${sizeLabel(rules.maxBytes)}.`, 413);
  const key = `${userId}/${propertyId}/${kind}-${randomUUID()}.${ext}`;
  const contentType = CONTENT_TYPES[ext];

  if (isSupabaseConfigured()) {
    const supabase = options.admin ? createSupabaseAdminClient() : await createSupabaseServerClient();
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUploadUrl(key);
    if (error || !data) throw new Error(error?.message ?? "Could not prepare the upload.");
    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(key);
    return {
      method: "PUT",
      url: data.signedUrl,
      headers: {
        "content-type": contentType,
        "cache-control": "max-age=31536000",
        "x-upsert": "false",
        apikey: supabasePublicKey()!,
      },
      assetUrl: pub.publicUrl,
    };
  }

  const exp = Date.now() + 30 * 60 * 1000;
  return {
    method: "PUT",
    url: `/api/uploads/${key}?exp=${exp}&sig=${sign(key, exp)}`,
    headers: { "content-type": contentType },
    assetUrl: `/api/assets/${key}`,
  };
}

/** The storage key behind an asset URL of the current storage mode, or null. */
function assetKeyOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const base = isSupabaseConfigured() ? `${supabaseUrl()}/storage/v1/object/public/${SUPABASE_BUCKET}/` : "/api/assets/";
  return url.startsWith(base) ? safeKey(url.slice(base.length).split("/")) : null;
}

/** True if `url` is an asset this user uploaded for this property (of the given kind, if any). */
export function isOwnedAssetUrl(url: unknown, userId: string, propertyId: string, kind?: UploadKind): boolean {
  const key = assetKeyOf(url);
  if (!key || !key.startsWith(`${userId}/${propertyId}/`)) return false;
  const actual = uploadKindOfKey(key);
  return !!actual && (!kind || actual === kind);
}

/**
 * Whether the file behind an asset URL was actually uploaded. Only a definite
 * "missing" answer returns false: if storage can't be asked, the upload is
 * given the benefit of the doubt.
 */
export async function assetExists(url: string, options: { admin?: boolean } = {}): Promise<boolean> {
  const key = assetKeyOf(url);
  if (!key) return false;
  if (!isSupabaseConfigured()) {
    const stat = await fs.stat(localUploadPath(key)).catch(() => null);
    return !!stat && stat.isFile() && stat.size > 0;
  }
  try {
    const supabase = options.admin ? createSupabaseAdminClient() : await createSupabaseServerClient();
    const { data } = await supabase.storage.from(SUPABASE_BUCKET).exists(key);
    return data !== false;
  } catch {
    return true;
  }
}
