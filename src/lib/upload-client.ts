"use client";

export type UploadKind = "capture" | "cover";

interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  assetUrl: string;
}

/**
 * Upload a file straight to storage (local signed URL or Supabase Storage)
 * with progress reporting. Returns the asset URL to store on the property.
 */
export async function uploadFile(
  propertyId: string,
  kind: UploadKind,
  file: Blob,
  filename: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const res = await fetch(`/api/properties/${propertyId}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, filename, size: file.size }),
  });
  const target = (await res.json()) as UploadTarget & { error?: string };
  if (!res.ok) throw new Error(target.error || "Could not start the upload.");

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(file);
  });
  onProgress?.(1);
  return target.assetUrl;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(",");
  const mime = head.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
  const bytes = atob(body);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
