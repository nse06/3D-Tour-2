// Asset storage for 3D captures and cover photos.
//
// Browsers upload directly (PUT) to a short-lived signed URL so large scans
// never pass through a serverless function body:
//  - local mode:    /api/uploads/<key>?exp&sig  → .data/uploads/<key>, served by /api/assets/<key>
//  - Supabase mode: Storage signed upload URL   → public bucket URL
//
// Keys are always <userId>/<propertyId>/<kind>-<uuid>.<ext>, which lets the
// server verify that a submitted asset URL really belongs to the property.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, localDataDir, SUPABASE_BUCKET } from "./data/config";

export type UploadKind = "capture" | "cover";

export const UPLOAD_RULES: Record<UploadKind, { extensions: string[]; maxBytes: number }> = {
  capture: { extensions: ["glb", "gltf"], maxBytes: 250 * 1024 * 1024 },
  cover: { extensions: ["jpg", "jpeg", "png", "webp"], maxBytes: 12 * 1024 * 1024 },
};

export const CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  assetUrl: string;
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

export async function createUploadTarget(
  userId: string,
  propertyId: string,
  kind: UploadKind,
  filename: string,
  size: number,
): Promise<UploadTarget> {
  const ext = extensionOf(filename);
  const rules = UPLOAD_RULES[kind];
  if (!rules.extensions.includes(ext)) throw new Error(`Please choose a ${rules.extensions.map((e) => "." + e).join(" or ")} file.`);
  if (!(size > 0) || size > rules.maxBytes) throw new Error(`Files must be smaller than ${Math.round(rules.maxBytes / 1024 / 1024)} MB.`);
  const key = `${userId}/${propertyId}/${kind}-${randomUUID()}.${ext}`;
  const contentType = CONTENT_TYPES[ext];

  if (isSupabaseConfigured()) {
    const supabase = await createSupabaseServerClient();
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
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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

/** True if `url` is an asset this user uploaded for this property. */
export function isOwnedAssetUrl(url: string, userId: string, propertyId: string): boolean {
  const prefix = `${userId}/${propertyId}/`;
  if (url.startsWith("/api/assets/")) return url.slice("/api/assets/".length).startsWith(prefix) && !url.includes("..");
  if (isSupabaseConfigured()) {
    const base = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/`;
    return url.startsWith(base) && url.slice(base.length).startsWith(prefix) && !url.includes("..");
  }
  return false;
}
