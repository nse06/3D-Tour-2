// Shared plumbing for the iPhone endpoints (/api/capture/sessions/<token>/…).
// The phone authenticates with nothing but the pairing token in the URL.

import "server-only";
import { hashCaptureToken, isWellFormedCaptureToken } from "@/lib/capture-sessions";
import { ConfigurationError, getAdminRepository, type Repository } from "@/lib/data/repository";
import type { CaptureSessionLookup } from "@/lib/data/types";
import { isMissingSchemaError } from "@/lib/setup";

const EXPIRED = "This pairing code has expired. Open the listing in the Atrium dashboard and tap Scan with iPhone to get a new one.";

export function apiError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/** The session behind a pairing token plus the repository to act with — or the error response to send. */
export async function resolveCaptureSession(token: string): Promise<{ repo: Repository; lookup: CaptureSessionLookup } | Response> {
  if (!isWellFormedCaptureToken(token)) return apiError(404, EXPIRED);
  try {
    const repo = await getAdminRepository();
    const lookup = await repo.findCaptureSessionByTokenHash(hashCaptureToken(token));
    return lookup ? { repo, lookup } : apiError(404, EXPIRED);
  } catch (e) {
    return serverError(e);
  }
}

export function serverError(e: unknown): Response {
  if (e instanceof ConfigurationError) return apiError(503, e.message);
  if (isMissingSchemaError(e)) return apiError(503, "Atrium's database isn't set up for iPhone scans yet. Open /setup on the Atrium website.");
  console.error("capture api:", e);
  return apiError(500, "Something went wrong on the Atrium server. Please try again.");
}

/** Parse a small JSON request body (rejects anything over `maxBytes`). */
export async function readJson(request: Request, maxBytes = 4 * 1024 * 1024): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const text = await request.text().catch(() => "");
  if (!text || text.length > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
