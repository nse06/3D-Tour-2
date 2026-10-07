"use client";

import { Check, Loader2, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { completeCaptureUploadAction } from "@/app/dashboard/actions";
import { formatBytes, inspectCaptureFile } from "@/lib/capture-file";
import { uploadFile } from "@/lib/upload-client";

type Phase = { kind: "idle" } | { kind: "working"; label: string; progress?: number } | { kind: "done"; label: string } | { kind: "error"; label: string };

/** Uploads a .glb/.gltf capture for an existing property. */
export function CaptureUploader({ propertyId, compact = false, onDone }: { propertyId: string; compact?: boolean; onDone?: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPhase({ kind: "working", label: "Reading capture…" });
      const inspected = await inspectCaptureFile(file);
      const assetUrl = await uploadFile(propertyId, "capture", file, file.name, (p) =>
        setPhase({ kind: "working", label: `Uploading ${formatBytes(file.size)}`, progress: p }),
      );
      setPhase({ kind: "working", label: inspected.manifest ? "Building rooms and walkthrough path…" : "Saving capture…" });
      const res = await completeCaptureUploadAction(propertyId, { assetUrl, format: inspected.format, manifest: inspected.manifest });
      if (!res.ok) throw new Error(res.error);
      setPhase({
        kind: "done",
        label: res.rooms ? `Capture attached — ${res.rooms} rooms detected automatically.` : "Capture attached. Next, mark the rooms buyers can visit.",
      });
      router.refresh();
      onDone?.();
    } catch (e) {
      setPhase({ kind: "error", label: (e as Error).message });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const busy = phase.kind === "working";
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handle(e.dataTransfer.files?.[0]);
        }}
        className={`flex w-full flex-col items-center justify-center rounded-2xl border border-dashed text-center transition ${
          compact ? "px-4 py-5" : "px-6 py-9"
        } ${dragging ? "border-gold bg-gold/5" : "border-sand bg-paper/60 hover:border-neutral-400 hover:bg-paper"}`}
      >
        {busy ? <Loader2 className="size-6 animate-spin text-gold" /> : <UploadCloud className="size-6 text-stone" strokeWidth={1.5} />}
        <span className="mt-2 text-sm font-medium text-ink">{busy ? phase.label : "Upload 3D capture"}</span>
        {!busy && <span className="mt-0.5 text-xs text-neutral-500">Drop a .glb or .gltf file, or click to browse</span>}
        {busy && phase.progress !== undefined && (
          <span className="mt-3 h-1 w-48 overflow-hidden rounded-full bg-sand">
            <span className="block h-full rounded-full bg-gold transition-[width]" style={{ width: `${Math.round(phase.progress * 100)}%` }} />
          </span>
        )}
      </button>
      <input ref={inputRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden" onChange={(e) => handle(e.target.files?.[0])} />
      {phase.kind === "done" && (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700">
          <Check className="size-4" /> {phase.label}
        </p>
      )}
      {phase.kind === "error" && <p className="mt-3 text-sm text-red-600">{phase.label}</p>}
    </div>
  );
}
