// Photoreal walkthroughs (docs/photoreal.md). The phone uploads a photo scan's training data
// (cameras.json, seeds.ply, frames/, masks/) straight to private storage, the server hands the job
// to a cloud GPU (worker/photoreal, PHOTOREAL_GPU_URL), and the worker reports back to
// /api/photoreal/jobs/<id> with the shared PHOTOREAL_WORKER_SECRET until the splats (.spz) are
// stored next to the tour's other files.

import "server-only";
import { timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSupabaseConfigured, supabasePublicKey } from "@/lib/data/config";
import type { Repository } from "@/lib/data/repository";
import type { PhotorealJob } from "@/lib/data/types";
import { CONTENT_TYPES, extensionOf, localUploadPath, localUploadUrl, signLocalRead } from "@/lib/storage";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/** Private bucket the photos wait in while the GPU trains on them (created by the photoreal migration). */
export const PHOTOREAL_BUCKET = "photoreal";

const FILE = /^(cameras\.json|seeds\.ply|frames\/[A-Za-z0-9_-]+\.(jpg|jpeg|png)|masks\/[A-Za-z0-9_-]+\.png)$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const INPUT_KEY = new RegExp(`^[\\w-]+/[\\w-]+/photoreal-${UUID}/${FILE.source.slice(1, -1)}$`);
export const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 4 * 1024 ** 3;
/** How long the GPU may take to fetch the photos once it has the job. */
const DOWNLOAD_LINK_SECONDS = 24 * 3600;

export interface PhotorealFile {
  name: string;
  size: number;
}

export interface UploadLink {
  name: string;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

/** The phone's list of files to upload, checked: names we expect, sizes within limits. */
export function checkPhotorealFiles(value: unknown): { files: PhotorealFile[]; bytes: number } | { error: string } {
  if (!Array.isArray(value) || !value.length) return { error: "Expected the list of files to upload." };
  if (value.length > MAX_FILES) return { error: `At most ${MAX_FILES} files.` };
  const files: PhotorealFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of value) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    const size = Number(entry?.size);
    if (!FILE.test(name)) return { error: `Unexpected file: ${name.slice(0, 80)}` };
    if (seen.has(name)) return { error: `Listed twice: ${name}` };
    if (!Number.isFinite(size) || size <= 0 || size > MAX_INPUT_FILE_BYTES) return { error: `${name}: unexpected size.` };
    seen.add(name);
    files.push({ name, size });
    bytes += size;
  }
  if (bytes > MAX_TOTAL_BYTES) return { error: "The photos add up to more than 4 GB." };
  if (!seen.has("cameras.json") || !seen.has("seeds.ply")) return { error: "cameras.json and seeds.ply are required." };
  const frames = files.filter((f) => f.name.startsWith("frames/")).length;
  if (frames < 10) return { error: "A photoreal walkthrough needs the scan's photos (at least 10)." };
  return { files, bytes };
}

function folderOf(job: PhotorealJob): string {
  return `${job.userId}/${job.propertyId}/photoreal-${job.id}`;
}

export function inputKey(job: PhotorealJob, name: string): string {
  return `${folderOf(job)}/${name}`;
}

/** Whether a storage key is one of a photoreal job's input files (local mode keeps them private). */
export function isPhotorealInputKey(key: string): boolean {
  return INPUT_KEY.test(key);
}

function contentType(name: string): string {
  return CONTENT_TYPES[extensionOf(name)] ?? "application/octet-stream";
}

async function inBatches<T, R>(items: T[], size: number, fn: (batch: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

/** Where the phone PUTs each file (the same file may be sent again: retries overwrite). */
export async function inputUploadLinks(job: PhotorealJob, files: PhotorealFile[]): Promise<UploadLink[]> {
  if (!isSupabaseConfigured()) {
    return files.map((f) => ({
      name: f.name,
      method: "PUT",
      url: localUploadUrl(inputKey(job, f.name), 6 * 60),
      headers: { "content-type": contentType(f.name) },
    }));
  }
  const bucket = createSupabaseAdminClient().storage.from(PHOTOREAL_BUCKET);
  return inBatches(files, 16, (batch) =>
    Promise.all(
      batch.map(async (f) => {
        const { data, error } = await bucket.createSignedUploadUrl(inputKey(job, f.name), { upsert: true });
        if (error || !data) throw new Error(error?.message ?? "Could not prepare the upload.");
        return {
          name: f.name,
          method: "PUT" as const,
          url: data.signedUrl,
          headers: { "content-type": contentType(f.name), "x-upsert": "true", apikey: supabasePublicKey()! },
        };
      }),
    ),
  );
}

/** The job's files that have arrived (names relative to the job's folder). */
export async function inputNames(job: PhotorealJob): Promise<string[]> {
  const folder = folderOf(job);
  if (!isSupabaseConfigured()) {
    const root = localUploadPath(folder);
    const names: string[] = [];
    for (const sub of ["", "frames", "masks"]) {
      // Run-time paths in the local data folder: nothing for the bundler to trace.
      const dir = path.join(/*turbopackIgnore: true*/ root, sub);
      const entries = await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isFile()) names.push(sub ? `${sub}/${e.name}` : e.name);
    }
    return names.filter((n) => FILE.test(n));
  }
  const bucket = createSupabaseAdminClient().storage.from(PHOTOREAL_BUCKET);
  const names: string[] = [];
  for (const sub of ["", "frames", "masks"]) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await bucket.list(sub ? `${folder}/${sub}` : folder, { limit: 1000, offset });
      if (error) throw new Error(error.message);
      for (const entry of data ?? []) if (entry.id) names.push(sub ? `${sub}/${entry.name}` : entry.name);
      if (!data || data.length < 1000) break;
    }
  }
  return names.filter((n) => FILE.test(n));
}

/** Links the GPU downloads the files from. `baseUrl`: this site, for local storage. */
export async function inputDownloadLinks(job: PhotorealJob, names: string[], baseUrl: string): Promise<{ name: string; url: string }[]> {
  if (!isSupabaseConfigured()) {
    const exp = Date.now() + DOWNLOAD_LINK_SECONDS * 1000;
    return names.map((name) => {
      const key = inputKey(job, name);
      return { name, url: `${baseUrl}/api/assets/${key}?exp=${exp}&sig=${signLocalRead(key, exp)}` };
    });
  }
  const bucket = createSupabaseAdminClient().storage.from(PHOTOREAL_BUCKET);
  return inBatches(names, 500, async (batch) => {
    const { data, error } = await bucket.createSignedUrls(
      batch.map((n) => inputKey(job, n)),
      DOWNLOAD_LINK_SECONDS,
    );
    if (error || !data) throw new Error(error?.message ?? "Could not sign the downloads.");
    return data.map((d, i) => {
      if (!d.signedUrl) throw new Error(`Could not sign ${batch[i]}: ${d.error ?? "missing"}`);
      return { name: batch[i], url: d.signedUrl };
    });
  });
}

/** Frees the photos once the splats exist (they stay on the phone). */
export async function deleteInputs(job: PhotorealJob): Promise<void> {
  if (!isSupabaseConfigured()) {
    await fs.rm(localUploadPath(folderOf(job)), { recursive: true, force: true });
    return;
  }
  const names = await inputNames(job);
  const bucket = createSupabaseAdminClient().storage.from(PHOTOREAL_BUCKET);
  await inBatches(names, 1000, async (batch) => {
    const { error } = await bucket.remove(batch.map((n) => inputKey(job, n)));
    if (error) throw new Error(error.message);
    return [];
  });
}

/** The secret the GPU worker and this site share (at least 16 characters), or null. */
export function workerSecret(): string | null {
  const secret = process.env.PHOTOREAL_WORKER_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

/** The GPU worker's start endpoint (the Modal deployment's URL), or null. */
export function gpuUrl(): string | null {
  const url = process.env.PHOTOREAL_GPU_URL?.trim();
  return url && /^https?:\/\//.test(url) ? url : null;
}

export function gpuConfigured(): boolean {
  return !!gpuUrl() && !!workerSecret();
}

/** Whether a request carries the worker's secret (Authorization: Bearer …). */
export function isWorkerRequest(request: Request): boolean {
  const secret = workerSecret();
  const header = request.headers.get("authorization") ?? "";
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const WAITING_FOR_GPU = "Waiting for the GPU to be connected (PHOTOREAL_GPU_URL and PHOTOREAL_WORKER_SECRET on the server).";

/**
 * Hands an uploaded job to the GPU. Without one configured the job waits in "queued" (it can be
 * started later from the dashboard); if the GPU doesn't take it, it waits there with the reason.
 */
export async function dispatchJob(repo: Repository, job: PhotorealJob, baseUrl: string): Promise<PhotorealJob> {
  const url = gpuUrl();
  const secret = workerSecret();
  if (!url || !secret) return (await repo.updatePhotorealJob(job.id, { status: "queued", stage: null, message: WAITING_FOR_GPU })) ?? job;
  const names = await inputNames(job);
  const files = await inputDownloadLinks(job, names, baseUrl);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jobId: job.id, callback: `${baseUrl}/api/photoreal/jobs/${job.id}`, files }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 200);
      return (
        (await repo.updatePhotorealJob(job.id, { status: "queued", message: `The GPU didn't take the job (HTTP ${response.status}) ${text}`.trim() })) ?? job
      );
    }
  } catch (e) {
    return (await repo.updatePhotorealJob(job.id, { status: "queued", message: `Couldn't reach the GPU: ${(e as Error).message}` })) ?? job;
  }
  return (
    (await repo.updatePhotorealJob(job.id, {
      status: "running",
      stage: "starting",
      progress: 0,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    })) ?? job
  );
}

/** What the dashboard and the phone show of a job. */
export function jobSummary(job: PhotorealJob) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    files: job.files,
    bytes: job.bytes,
    splatUrl: job.splatUrl,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stats: job.stats,
  };
}
