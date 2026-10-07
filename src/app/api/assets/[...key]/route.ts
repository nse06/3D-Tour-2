import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { CONTENT_TYPES, extensionOf, localUploadPath, safeKey } from "@/lib/storage";

/** Serves locally stored captures/covers. Keys are unique, so responses are immutable. */
export async function GET(_request: Request, ctx: RouteContext<"/api/assets/[...key]">) {
  const key = safeKey((await ctx.params).key);
  if (!key) return new Response("Not found", { status: 404 });
  const file = localUploadPath(key);
  try {
    const stat = await fs.stat(file);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: {
        "content-type": CONTENT_TYPES[extensionOf(key)] ?? "application/octet-stream",
        "content-length": String(stat.size),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
