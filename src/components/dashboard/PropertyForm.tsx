"use client";

import { Box, Check, Clock, Loader2, Smartphone, Sparkles, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { completeCaptureUploadAction, type PropertyFormState } from "@/app/dashboard/actions";
import { Button, Field, inputClass } from "@/components/ui";
import { formatBytes, inspectCaptureFile } from "@/lib/capture-file";
import type { PropertyInput } from "@/lib/data/types";
import { DEMO_LISTING } from "@/lib/demo/listing";
import { uploadFile } from "@/lib/upload-client";

type CaptureChoice = "demo" | "phone" | "upload" | "later";

interface Props {
  mode: "create" | "edit";
  action: (state: PropertyFormState, fd: FormData) => Promise<PropertyFormState>;
  initial?: Partial<PropertyInput>;
}

export function PropertyForm({ mode, action, initial }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, {});
  const [values, setValues] = useState<Partial<PropertyInput>>(initial ?? {});
  const [formKey, setFormKey] = useState(0);
  const [capture, setCapture] = useState<CaptureChoice>("demo");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ label: string; progress?: number } | null>(null);
  const started = useRef<string | null>(null);
  // Prefer values echoed by the last submit, unless the realtor just prefilled the sample listing.
  const [useLocalValues, setUseLocalValues] = useState(false);

  // After a "create + upload" submit, the property exists: upload the file straight to storage.
  useEffect(() => {
    const id = state.propertyId;
    if (!id || !file || started.current === id) return;
    started.current = id;
    (async () => {
      try {
        setUpload({ label: "Reading capture…" });
        const inspected = await inspectCaptureFile(file);
        const assetUrl = await uploadFile(id, "capture", file, file.name, (p) => setUpload({ label: `Uploading ${formatBytes(file.size)}`, progress: p }));
        setUpload({ label: "Building rooms and walkthrough path…" });
        const res = await completeCaptureUploadAction(id, { assetUrl, manifest: inspected.manifest });
        if (!res.ok) throw new Error(res.error);
      } catch (e) {
        setFileError(`Listing saved, but the capture upload failed: ${(e as Error).message}`);
      }
      router.push(`/dashboard/properties/${id}`);
    })();
  }, [state.propertyId, file, router]);

  const fe = state.fieldErrors ?? {};
  const busy = pending || !!upload;
  const current: Partial<Record<keyof PropertyInput, string | number>> = state.values && !useLocalValues ? state.values : values;
  const v = (k: keyof PropertyInput) => {
    const val = current[k];
    if (val === undefined || val === null) return "";
    return typeof val === "number" && (k === "price" || k === "squareFeet") ? val.toLocaleString("en-US") : String(val);
  };

  return (
    <form
      key={formKey}
      action={(fd) => {
        setUseLocalValues(false);
        formAction(fd);
      }}
      className="space-y-10"
      onSubmit={(e) => {
        if (mode === "create" && capture === "upload" && !file) {
          e.preventDefault();
          setFileError("Choose a .glb or .gltf file, or pick another option.");
        }
      }}
    >
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionTitle n={1} title="Property" subtitle="Where is it, and what should buyers call it?" />
          {mode === "create" && (
            <button
              type="button"
              onClick={() => {
                setUseLocalValues(true);
                setValues(DEMO_LISTING);
                setFormKey((k) => k + 1);
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-linen px-3 py-1.5 text-xs font-medium text-stone transition hover:text-ink"
            >
              <Sparkles className="size-3.5" /> Fill with sample listing
            </button>
          )}
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-6">
          <Field label="Street address" error={fe.addressLine} className="md:col-span-4">
            <input name="addressLine" defaultValue={v("addressLine")} placeholder="1234 Sheridan Road" className={inputClass} autoComplete="street-address" />
          </Field>
          <Field label="ZIP" className="md:col-span-2">
            <input name="postalCode" defaultValue={v("postalCode")} placeholder="60091" className={inputClass} inputMode="numeric" />
          </Field>
          <Field label="City" error={fe.city} className="md:col-span-4">
            <input name="city" defaultValue={v("city")} placeholder="Wilmette" className={inputClass} />
          </Field>
          <Field label="State" className="md:col-span-2">
            <input name="state" defaultValue={v("state")} placeholder="IL" className={inputClass} />
          </Field>
          <Field label="Listing title" hint="Optional headline shown in the property details." className="md:col-span-6">
            <input name="title" defaultValue={v("title")} placeholder="Lakeside Georgian on Sheridan Road" className={inputClass} />
          </Field>
        </div>
      </section>

      <section>
        <SectionTitle n={2} title="Details" subtitle="The essentials buyers look for first." />
        <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label="Price" error={fe.price}>
            <input name="price" defaultValue={v("price")} placeholder="2,495,000" className={inputClass} inputMode="numeric" />
          </Field>
          <Field label="Beds" error={fe.bedrooms}>
            <input name="bedrooms" defaultValue={v("bedrooms")} placeholder="5" className={inputClass} inputMode="numeric" />
          </Field>
          <Field label="Baths" error={fe.bathrooms}>
            <input name="bathrooms" defaultValue={v("bathrooms")} placeholder="4.5" className={inputClass} inputMode="decimal" />
          </Field>
          <Field label="Square feet" error={fe.squareFeet}>
            <input name="squareFeet" defaultValue={v("squareFeet")} placeholder="4,200" className={inputClass} inputMode="numeric" />
          </Field>
          <Field label="Description" className="col-span-2 md:col-span-4">
            <textarea
              name="description"
              defaultValue={v("description")}
              rows={6}
              placeholder="What makes this home special?"
              className={`${inputClass} resize-y leading-relaxed`}
            />
          </Field>
        </div>
      </section>

      {mode === "create" && (
        <section>
          <SectionTitle n={3} title="3D capture" subtitle="The walkthrough buyers will explore." />
          <input type="hidden" name="capture" value={capture} />
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <ChoiceCard
              active={capture === "phone"}
              onClick={() => setCapture("phone")}
              icon={<Smartphone className="size-5" strokeWidth={1.5} />}
              title="Scan with iPhone"
              text="Walk the home with the Atrium Capture app (iPhone with LiDAR). Rooms and the walkthrough path are built for you."
            />
            <ChoiceCard
              active={capture === "demo"}
              onClick={() => setCapture("demo")}
              icon={<Box className="size-5" strokeWidth={1.5} />}
              title="Sample capture"
              text="Attach the 1234 Sheridan Road demo home — 10 rooms, 2 floors."
            />
            <ChoiceCard
              active={capture === "upload"}
              onClick={() => setCapture("upload")}
              icon={<UploadCloud className="size-5" strokeWidth={1.5} />}
              title="Upload a model"
              text="A .glb or .gltf of the property. Rooms are detected if the file includes a scan manifest."
            />
            <ChoiceCard
              active={capture === "later"}
              onClick={() => setCapture("later")}
              icon={<Clock className="size-5" strokeWidth={1.5} />}
              title="Add later"
              text="Save the listing now and attach a capture from its page."
            />
          </div>
          {capture === "upload" && (
            <label className="mt-4 flex cursor-pointer items-center gap-4 rounded-2xl border border-dashed border-sand bg-paper/60 px-5 py-4 transition hover:border-neutral-400">
              <UploadCloud className="size-5 shrink-0 text-stone" />
              <span className="flex-1 text-sm">
                {file ? (
                  <>
                    <span className="font-medium text-ink">{file.name}</span> <span className="text-neutral-500">· {formatBytes(file.size)}</span>
                  </>
                ) : (
                  <span className="text-neutral-500">Choose a .glb or .gltf file…</span>
                )}
              </span>
              <input
                type="file"
                accept=".glb,.gltf"
                className="hidden"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setFileError(null);
                }}
              />
              <span className="rounded-full bg-white px-3 py-1 text-xs font-medium shadow-sm ring-1 ring-sand">Browse</span>
            </label>
          )}
        </section>
      )}

      {(state.error || fileError) && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{state.error || fileError}</p>}

      <div className="flex items-center gap-4 border-t border-sand pt-6">
        <Button type="submit" size="lg" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {upload ? upload.label : mode === "create" ? "Create listing" : "Save changes"}
        </Button>
        {upload?.progress !== undefined && (
          <span className="h-1 w-40 overflow-hidden rounded-full bg-sand">
            <span className="block h-full bg-gold transition-[width]" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
          </span>
        )}
        {mode === "edit" && state.saved && !pending && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-700">
            <Check className="size-4" /> Saved
          </span>
        )}
      </div>
    </form>
  );
}

function SectionTitle({ n, title, subtitle }: { n: number; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-semibold text-white">{n}</span>
      <div>
        <h2 className="font-display text-[28px] leading-none">{title}</h2>
        <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>
      </div>
    </div>
  );
}

function ChoiceCard({ active, onClick, icon, title, text }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; text: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border p-4 text-left transition ${active ? "border-ink bg-white shadow-md ring-1 ring-ink" : "border-sand bg-white/60 hover:border-neutral-400"}`}
    >
      <span className={`grid size-9 place-items-center rounded-xl ${active ? "bg-ink text-white" : "bg-linen text-stone"}`}>{icon}</span>
      <span className="mt-3 block font-medium text-ink">{title}</span>
      <span className="mt-1 block text-[13px] leading-snug text-neutral-500">{text}</span>
    </button>
  );
}
