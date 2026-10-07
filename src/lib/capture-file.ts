"use client";

import { findManifestInGltfJson, readManifestFromGlb, type ScanManifest } from "@/lib/tour/scan-manifest";

export interface InspectedCapture {
  format: "glb" | "gltf";
  manifest: ScanManifest | null;
}

/**
 * Validate a capture file in the browser before uploading and pull out its
 * embedded scan manifest (floors, rooms, waypoints), if it has one.
 */
export async function inspectCaptureFile(file: File): Promise<InspectedCapture> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "glb") {
    const head = new DataView(await file.slice(0, 4).arrayBuffer());
    if (head.byteLength < 4 || head.getUint32(0, true) !== 0x46546c67) throw new Error("This doesn't look like a valid .glb file.");
    return { format: "glb", manifest: await readManifestFromGlb(file) };
  }
  if (ext === "gltf") {
    const text = await file.text();
    let json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("This .gltf file isn't valid JSON.");
    }
    const external = [...(json.buffers ?? []), ...(json.images ?? [])].some((b) => b.uri && !b.uri.startsWith("data:"));
    if (external) throw new Error("This .gltf references external files. Export it as a single .glb (binary glTF) and upload that instead.");
    return { format: "gltf", manifest: findManifestInGltfJson(text) };
  }
  throw new Error("Please choose a .glb or .gltf file.");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
