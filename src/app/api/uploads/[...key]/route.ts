import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { isSupabaseConfigured } from "@/lib/data/config";
import { extensionOf, localUploadPath, safeKey, UPLOAD_RULES, verifyLocalUpload } from "@/lib/storage";

/** Local-mode upload sink for signed PUT requests (Supabase mode uploads straight to Storage). */
export async function PUT(request: Request, ctx: RouteContext<"/api/uploads/[...key]">) {
  if (isSupabaseConfigured()) return new Response("Not found", { status: 404 });
  const key = safeKey((await ctx.params).key);
  const url = new URL(request.url);
  if (!key || !verifyLocalUpload(key, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("Upload link is invalid or expired", { status: 403 });
  }
  if (!request.body) return new Response("Empty upload", { status: 400 });
  const kind = key.split("/")[2]?.startsWith("cover-") ? "cover" : "capture";
  const limit = UPLOAD_RULES[kind].maxBytes;
  if (!UPLOAD_RULES[kind].extensions.includes(extensionOf(key))) return new Response("Unsupported file type", { status: 400 });

  const dest = localUploadPath(key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      cb(received > limit ? new Error("File too large") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(request.body as unknown as WebReadableStream), limiter, createWriteStream(dest));
  } catch (e) {
    await fs.rm(dest, { force: true });
    return new Response((e as Error).message, { status: 413 });
  }
  return Response.json({ ok: true, bytes: received });
}
