import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { isPhotorealInputKey } from "@/lib/photoreal";
import { CONTENT_TYPES, extensionOf, localUploadPath, safeKey, verifyLocalRead } from "@/lib/storage";

/**
 * Serves locally stored captures/covers. Keys are unique, so responses are immutable. A photoreal
 * job's photos are private: they need the signed link the GPU worker was given.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/assets/[...key]">) {
  const key = safeKey((await ctx.params).key);
  if (!key) return new Response("Not found", { status: 404 });
  if (isPhotorealInputKey(key)) {
    const url = new URL(request.url);
    if (!verifyLocalRead(key, url.searchParams.get("exp"), url.searchParams.get("sig"))) return new Response("Not found", { status: 404 });
  }
  const file = localUploadPath(key);
  try {
    const stat = await fs.stat(file);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: {
        "content-type": CONTENT_TYPES[extensionOf(key)] ?? "application/octet-stream",
        "content-length": String(stat.size),
        "cache-control": isPhotorealInputKey(key) ? "private, no-store" : "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
