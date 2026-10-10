"use client";

import { ImagePlus, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setCoverImageAction } from "@/app/dashboard/actions";
import { uploadFile } from "@/lib/upload-client";

/** Wide enough for a sharp card and link preview, small enough to keep the listings page quick. */
const MAX_WIDTH = 1600;

/** The realtor's own cover photo (a listing photo they already have), shrunk before it's uploaded. */
export function CoverUpload({ propertyId, hasCover }: { propertyId: string; hasCover: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const blob = await shrink(file);
      const url = await uploadFile(propertyId, "cover", blob, "cover.jpg");
      const res = await setCoverImageAction(propertyId, url);
      if (!res.ok) throw new Error(res.error);
      router.refresh();
    } catch (e) {
      setError((e as Error).message || "That photo couldn't be used.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label
        className={`absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-white ${busy ? "pointer-events-none opacity-70" : "cursor-pointer"}`}
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
        {hasCover ? "Change cover" : "Upload a cover photo"}
      </label>
      {error && <p className="absolute bottom-3 right-3 z-10 max-w-[70%] rounded-xl bg-red-50 px-3 py-1.5 text-xs text-red-700">{error}</p>}
    </>
  );
}

/** A JPEG at most MAX_WIDTH wide (the photo's own orientation kept). */
async function shrink(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That file isn't a photo this browser can read (JPEG, PNG or WebP).");
  }
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  if (scale === 1 && file.type === "image/jpeg" && file.size < 1_500_000) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("That photo couldn't be prepared."))), "image/jpeg", 0.86),
  );
}
