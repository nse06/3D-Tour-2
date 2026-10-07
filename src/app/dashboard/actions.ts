"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/data/config";
import { getRepository } from "@/lib/data/repository";
import type { PropertyInput } from "@/lib/data/types";
import { DEMO_ASSET_URL, DEMO_COVER_URL, demoManifest } from "@/lib/demo";
import { isScanManifest, manifestToSpace } from "@/lib/tour/scan-manifest";
import { isSpaceError, newId, parseSpace } from "@/lib/tour/space";
import { isOwnedAssetUrl } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface PropertyFormState {
  error?: string;
  /** Submitted values, echoed back so the form keeps them after React resets it. */
  values?: Partial<Record<keyof PropertyInput, string>>;
  fieldErrors?: Partial<Record<keyof PropertyInput, string>>;
  propertyId?: string;
  saved?: number;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Property details
// ---------------------------------------------------------------------------

function text(fd: FormData, name: string, max: number) {
  return String(fd.get(name) ?? "")
    .trim()
    .slice(0, max);
}

function numberFrom(fd: FormData, name: string) {
  const raw = String(fd.get(name) ?? "").replace(/[^0-9.]/g, "");
  return raw ? Number(raw) : NaN;
}

const FIELDS: (keyof PropertyInput)[] = ["addressLine", "title", "city", "state", "postalCode", "price", "bedrooms", "bathrooms", "squareFeet", "description"];

function rawValues(fd: FormData): PropertyFormState["values"] {
  return Object.fromEntries(FIELDS.map((f) => [f, String(fd.get(f) ?? "")]));
}

function parsePropertyForm(fd: FormData): { input: PropertyInput; fieldErrors?: PropertyFormState["fieldErrors"] } {
  const errors: NonNullable<PropertyFormState["fieldErrors"]> = {};
  const input: PropertyInput = {
    addressLine: text(fd, "addressLine", 120),
    title: text(fd, "title", 120),
    city: text(fd, "city", 60),
    state: text(fd, "state", 40),
    postalCode: text(fd, "postalCode", 20),
    price: numberFrom(fd, "price"),
    bedrooms: numberFrom(fd, "bedrooms"),
    bathrooms: numberFrom(fd, "bathrooms"),
    squareFeet: numberFrom(fd, "squareFeet"),
    description: text(fd, "description", 5000),
  };
  if (!input.addressLine) errors.addressLine = "Enter the street address.";
  if (!input.city) errors.city = "Enter the city.";
  if (!Number.isFinite(input.price) || input.price < 0 || input.price > 1e10) errors.price = "Enter a valid price.";
  if (!Number.isFinite(input.bedrooms) || input.bedrooms < 0 || input.bedrooms > 50) errors.bedrooms = "0–50";
  if (!Number.isFinite(input.bathrooms) || input.bathrooms < 0 || input.bathrooms > 50) errors.bathrooms = "0–50";
  if (!Number.isFinite(input.squareFeet) || input.squareFeet < 0 || input.squareFeet > 1e6) errors.squareFeet = "Enter square footage.";
  input.price = Math.round(input.price || 0);
  input.bedrooms = Math.round(input.bedrooms || 0);
  input.bathrooms = Math.round((input.bathrooms || 0) * 2) / 2;
  input.squareFeet = Math.round(input.squareFeet || 0);
  return { input, fieldErrors: Object.keys(errors).length ? errors : undefined };
}

export async function createPropertyAction(_prev: PropertyFormState, fd: FormData): Promise<PropertyFormState> {
  const user = await requireUser();
  const { input, fieldErrors } = parsePropertyForm(fd);
  const values = rawValues(fd);
  if (fieldErrors) return { fieldErrors, values };
  const repo = await getRepository();
  let propertyId: string;
  try {
    const property = await repo.createProperty(user.id, input);
    propertyId = property.id;
    if (fd.get("capture") === "demo") await attachDemo(user.id, property.id);
  } catch (e) {
    return { error: (e as Error).message, values };
  }
  revalidatePath("/dashboard");
  // Uploads continue in the browser (direct-to-storage), then navigate.
  if (fd.get("capture") === "upload") return { propertyId, values };
  redirect(`/dashboard/properties/${propertyId}`);
}

export async function updatePropertyAction(propertyId: string, _prev: PropertyFormState, fd: FormData): Promise<PropertyFormState> {
  const user = await requireUser();
  const { input, fieldErrors } = parsePropertyForm(fd);
  const values = rawValues(fd);
  if (fieldErrors) return { fieldErrors, values };
  try {
    await (await getRepository()).updateProperty(user.id, propertyId, input);
  } catch (e) {
    return { error: (e as Error).message, values };
  }
  revalidatePath(`/dashboard/properties/${propertyId}`);
  revalidatePath("/dashboard");
  return { saved: Date.now(), values };
}

export async function deletePropertyAction(propertyId: string): Promise<void> {
  const user = await requireUser();
  await (await getRepository()).deleteProperty(user.id, propertyId);
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export async function setPublishedAction(propertyId: string, published: boolean): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await (await getRepository()).setPublished(user.id, propertyId, published);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/dashboard/properties/${propertyId}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3D capture
// ---------------------------------------------------------------------------

async function attachDemo(userId: string, propertyId: string) {
  const repo = await getRepository();
  await repo.attachCapture(userId, propertyId, {
    assetUrl: DEMO_ASSET_URL,
    assetFormat: "glb",
    source: "demo",
    space: manifestToSpace(demoManifest(), () => newId()),
  });
  const bundle = await repo.getProperty(userId, propertyId);
  if (bundle && !bundle.property.coverImageUrl) await repo.setCoverImage(userId, propertyId, DEMO_COVER_URL);
}

export async function attachDemoCaptureAction(propertyId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await attachDemo(user.id, propertyId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/dashboard/properties/${propertyId}`);
  return { ok: true };
}

/**
 * Called after the browser finished uploading a capture to storage. If the
 * file carries a scan manifest (as the demo capture does, and as future
 * iPhone scans will), floors/rooms/waypoints are created automatically.
 */
export async function completeCaptureUploadAction(
  propertyId: string,
  upload: { assetUrl: string; format: "glb" | "gltf"; manifest: unknown },
): Promise<ActionResult & { rooms?: number }> {
  const user = await requireUser();
  if (!isOwnedAssetUrl(upload.assetUrl, user.id, propertyId)) return { ok: false, error: "Unknown upload." };
  try {
    const space = isScanManifest(upload.manifest) ? parseSpace(manifestToSpace(upload.manifest, () => newId())) : null;
    await (
      await getRepository()
    ).attachCapture(user.id, propertyId, {
      assetUrl: upload.assetUrl,
      assetFormat: upload.format === "gltf" ? "gltf" : "glb",
      source: "upload",
      space,
    });
    revalidatePath(`/dashboard/properties/${propertyId}`);
    return { ok: true, rooms: space?.rooms.length ?? 0 };
  } catch (e) {
    return { ok: false, error: isSpaceError(e) ? `The capture's room data is invalid: ${(e as Error).message}` : (e as Error).message };
  }
}

export async function saveSpaceAction(propertyId: string, space: unknown): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await (await getRepository()).saveSpace(user.id, propertyId, parseSpace(space));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/dashboard/properties/${propertyId}`);
  return { ok: true };
}

export async function setCoverImageAction(propertyId: string, assetUrl: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!isOwnedAssetUrl(assetUrl, user.id, propertyId)) return { ok: false, error: "Unknown upload." };
  await (await getRepository()).setCoverImage(user.id, propertyId, assetUrl);
  revalidatePath(`/dashboard/properties/${propertyId}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signOutAction(): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
