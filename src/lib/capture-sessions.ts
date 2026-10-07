// Pairing the Atrium Capture iPhone app with a listing (docs/iphone-capture.md §3.1).
//
// The dashboard creates a capture session and shows a QR code for the deep
// link atriumcapture://pair?server=<base URL>&token=<token>. The phone then
// calls /api/capture/sessions/<token>/… with nothing but that token, so the
// token is 32 random bytes and only its SHA-256 is stored.

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

/** How long a pairing code works. */
export const CAPTURE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function hashCaptureToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh pairing token (base64url) and the hash that gets stored. */
export function newCaptureToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashCaptureToken(token) };
}

/** Our tokens are exactly 43 base64url characters; anything else can't match a session. */
export function isWellFormedCaptureToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function pairingDeepLink(baseUrl: string, token: string): string {
  return `atriumcapture://pair?server=${encodeURIComponent(baseUrl)}&token=${token}`;
}

export interface ServerBaseUrl {
  /** Origin the phone talks to, without a trailing slash. */
  url: string;
  /** Only reachable on the local network: the iPhone must be on the same Wi-Fi. */
  lan: boolean;
}

/**
 * The origin the phone should use: NEXT_PUBLIC_SITE_URL if set, else the
 * request's own origin. "localhost" would point the phone at itself, so a
 * loopback host is replaced by this machine's LAN IPv4 address (same port).
 */
export function serverBaseUrl(headers: Headers): ServerBaseUrl {
  const site = siteUrl();
  const proto = site?.protocol.replace(":", "") ?? (first(headers.get("x-forwarded-proto")) === "https" ? "https" : "http");
  const host = site?.host ?? (first(headers.get("x-forwarded-host")) || headers.get("host") || "localhost");
  const { hostname, port } = splitHost(host);
  if (isLocalOnly(hostname)) {
    const ip = lanIPv4();
    if (ip) return { url: `${proto}://${ip}${port ? `:${port}` : ""}`, lan: true };
  }
  return { url: `${proto}://${host}`, lan: isPrivateHost(hostname) };
}

function siteUrl(): URL | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function first(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function splitHost(host: string): { hostname: string; port: string } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (v6) return { hostname: v6[1].toLowerCase(), port: v6[2] ?? "" };
  const [hostname, port = ""] = host.split(":");
  return { hostname: hostname.toLowerCase(), port };
}

/** Hosts a phone can't reach this machine by (they would point at the phone itself). */
function isLocalOnly(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname.endsWith(".localhost") || /^127\./.test(hostname) || hostname === "::1" || hostname === "0.0.0.0" || hostname === "::"
  );
}

function privateRank(ip: string): number {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (/^169\.254\./.test(ip)) return 3;
  return -1;
}

function isPrivateHost(hostname: string): boolean {
  return privateRank(hostname) >= 0 || hostname.endsWith(".local");
}

/** This machine's address on the local network, preferring typical home/office Wi-Fi ranges. */
function lanIPv4(): string | null {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => !!a && String(a.family).replace("IPv", "") === "4" && !a.internal)
    .map((a) => a!.address);
  const rank = (ip: string) => (privateRank(ip) < 0 ? 9 : privateRank(ip));
  return addresses.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
