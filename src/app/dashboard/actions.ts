"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { requireUser } from "@/lib/auth";
import { claim, listingAccess, photorealAccess, type Access } from "@/lib/billing/access";
import type { PriceKey } from "@/lib/billing/plans";
import { cancelSubscriptionsNow, checkoutUrl } from "@/lib/billing/stripe";
import { CAPTURE_SESSION_TTL_MS, newCaptureToken, pairingDeepLink, serverBaseUrl } from "@/lib/capture-sessions";
import { isSupabaseConfigured, storageMode } from "@/lib/data/config";
import { adminRepositoryUnavailableReason, bundleToTourData, getAdminRepository, getRepository } from "@/lib/data/repository";
import type { PropertyInput } from "@/lib/data/types";
import { DEMO_ASSET_URL, DEMO_COVER_URL, demoManifest } from "@/lib/demo";
import { ingestCapture } from "@/lib/ingest";
import {
  deleteListingPhotos,
  deletePhotos,
  dispatchJob,
  gpuConfigured,
  inputNames,
  PHOTOS_GONE,
  photosJobId,
  photosOnServer,
  WAITING_FOR_GPU,
} from "@/lib/photoreal";
import { NO_PHOTOS, photosForRemaster, queueRemaster, remasterBusy, remasterConfigured, WAITING_FOR_REMASTER_GPU } from "@/lib/remaster";
import { manifestToSpace } from "@/lib/tour/scan-manifest";
import { newId, parseSpace } from "@/lib/tour/space";
import type { TourAppearance, TourData } from "@/lib/tour/types";
import { requestOrigin } from "@/lib/request-origin";
import { deleteStoredFiles, isOwnedAssetUrl } from "@/lib/storage";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
  /** It costs money: Stripe's checkout page, where the realtor pays and comes back. */
  checkoutUrl?: string;
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
  // The listing page shows the iPhone pairing code right away.
  redirect(`/dashboard/properties/${propertyId}${fd.get("capture") === "phone" ? "?scan=1" : ""}`);
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
  const repo = await getRepository();
  // Only the listing's owner gets this far (the property is looked up through their session).
  if (await repo.getProperty(user.id, propertyId)) {
    await deleteListingPhotos(user.id, propertyId).catch((e) => console.error("photoreal: could not delete the listing's photos:", (e as Error).message));
    await deleteStoredFiles(user.id, propertyId).catch((e) => console.error("storage: could not delete the listing's files:", (e as Error).message));
  }
  await repo.deleteProperty(user.id, propertyId);
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

/**
 * Deletes the realtor's account and everything in it (/legal/delete-account says what): subscriptions
 * end now, every listing goes with its walkthrough, files and photos, then the login itself. The
 * database drops the rest with the login (billing rows cascade); Stripe keeps the invoices.
 */
export async function deleteAccountAction(_previous: { error?: string }, form: FormData): Promise<{ error?: string }> {
  const user = await requireUser();
  if (String(form.get("confirm") ?? "").trim().toUpperCase() !== "DELETE") return { error: "Type DELETE to confirm." };
  try {
    if (isSupabaseConfigured()) {
      const unavailable = adminRepositoryUnavailableReason();
      if (unavailable) return { error: `Accounts can't be deleted here yet: ${unavailable}` };
    }
    await cancelSubscriptionsNow(user.id);
    const repo = await getRepository();
    for (const { property } of await repo.listProperties(user.id)) {
      await deleteListingPhotos(user.id, property.id);
      await repo.deleteProperty(user.id, property.id);
    }
    await deleteStoredFiles(user.id);
    if (isSupabaseConfigured()) {
      const { error } = await createSupabaseAdminClient().auth.admin.deleteUser(user.id);
      if (error) throw new Error(error.message);
      await (await createSupabaseServerClient()).auth.signOut().catch(() => undefined);
    }
  } catch (e) {
    return { error: `Your account couldn't be fully deleted: ${(e as Error).message}. Try again, or write to us and we'll finish it.` };
  }
  redirect("/legal/delete-account?deleted=1");
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Claims what an action costs nothing for (docs/billing.md), or returns Stripe's checkout page when
 * it has to be paid for first.
 */
async function claimOrCheckout(lookup: () => Promise<Access>, checkout: (price: PriceKey) => Promise<string>): Promise<string | null> {
  let access = await lookup();
  // The free first listing can go to another listing at the same moment: then this one is paid.
  if (access.allowed && !(await claim(access))) {
    access = await lookup();
    if (access.allowed) await claim(access);
  }
  return access.allowed ? null : checkout(access.price);
}

export async function setPublishedAction(propertyId: string, published: boolean): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const repo = await getRepository();
    if (published) {
      const bundle = await repo.getProperty(user.id, propertyId);
      if (!bundle) return { ok: false, error: "Property not found." };
      if (!bundle.tour) return { ok: false, error: "Attach a 3D capture before publishing." };
      const origin = requestOrigin(await headers());
      const pay = await claimOrCheckout(
        () => listingAccess(user, propertyId),
        (price) =>
          checkoutUrl({
            payer: user,
            price,
            propertyId,
            description: `Atrium listing: ${bundle.property.addressLine}`,
            origin,
            cancelPath: `/dashboard/properties/${propertyId}`,
          }),
      );
      if (pay) return { ok: false, checkoutUrl: pay };
    }
    await repo.setPublished(user.id, propertyId, published);
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
 * file carries a scan manifest (the demo capture and iPhone scans do),
 * floors/rooms/waypoints are created automatically.
 */
export async function completeCaptureUploadAction(
  propertyId: string,
  upload: { assetUrl: string; manifest: unknown },
): Promise<ActionResult & { rooms?: number }> {
  const user = await requireUser();
  const repo = await getRepository();
  if (!(await repo.getProperty(user.id, propertyId))) return { ok: false, error: "Property not found." };
  const result = await ingestCapture(repo, user.id, propertyId, "upload", { assetUrl: upload.assetUrl, manifest: upload.manifest ?? null });
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath(`/dashboard/properties/${propertyId}`);
  return { ok: true, rooms: result.rooms };
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

export async function setAppearanceAction(propertyId: string, appearance: TourAppearance): Promise<ActionResult> {
  const user = await requireUser();
  if (appearance !== "studio" && appearance !== "captured" && appearance !== "photoreal" && appearance !== "remastered")
    return { ok: false, error: "Unknown appearance." };
  try {
    const repo = await getRepository();
    if (appearance === "remastered" && !(await repo.getProperty(user.id, propertyId))?.tour?.remasterUrl) {
      return { ok: false, error: "Remaster the scan first: there's no remastered model yet." };
    }
    await repo.setAppearance(user.id, propertyId, appearance);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/dashboard/properties/${propertyId}`);
  revalidatePath(`/dashboard/properties/${propertyId}/preview`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Photoreal walkthroughs (docs/photoreal.md)
// ---------------------------------------------------------------------------

/**
 * Hands the listing's waiting (or failed) photoreal job to the GPU again, or sends the realtor to
 * pay for photoreal first; the job starts by itself once they have.
 */
export async function startPhotorealAction(propertyId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    // Through the realtor's own session first: only their job is found.
    const repo = await getRepository();
    const job = await repo.latestPhotorealJob(user.id, propertyId);
    if (!job) return { ok: false, error: "No photos have been sent for a photoreal walkthrough yet." };
    if (job.status !== "queued" && job.status !== "failed")
      return { ok: false, error: `The photoreal walkthrough is already ${job.status === "done" ? "ready" : job.status}.` };
    if (!gpuConfigured()) return { ok: false, error: WAITING_FOR_GPU };
    if ((await inputNames(job)).length < job.files) return { ok: false, error: PHOTOS_GONE };
    const address = (await repo.getProperty(user.id, propertyId))?.property.addressLine ?? "your listing";
    const origin = requestOrigin(await headers());
    const pay = await claimOrCheckout(
      () => photorealAccess(user, propertyId),
      (price) =>
        checkoutUrl({
          payer: user,
          price,
          propertyId,
          description: `Photoreal walkthrough: ${address}`,
          origin,
          cancelPath: `/dashboard/properties/${propertyId}`,
        }),
    );
    if (pay) return { ok: false, checkoutUrl: pay };
    const started = await dispatchJob(await getAdminRepository(), job, serverBaseUrl(await headers()).url);
    revalidatePath(`/dashboard/properties/${propertyId}`);
    return started.status === "running" ? { ok: true } : { ok: false, error: started.message ?? "The GPU didn't take the job." };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Trains the listing's photoreal walkthrough again from the photos already on the server (a newer
 * trainer, another version): a new job, no rescan. Photoreal paid for once covers it; otherwise the
 * job waits and the realtor pays first, like the first time.
 */
export async function retrainPhotorealAction(propertyId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const repo = await getRepository();
    const latest = await repo.latestPhotorealJob(user.id, propertyId);
    if (!latest) return { ok: false, error: "No photos have been sent for a photoreal walkthrough yet." };
    if (latest.status !== "done" && latest.status !== "failed") return { ok: false, error: "The photoreal walkthrough is already on its way." };
    if (!gpuConfigured()) return { ok: false, error: WAITING_FOR_GPU };
    const source = await repo.getPhotorealJob(photosJobId(latest));
    if (!source || source.inputsDeletedAt || !(await photosOnServer(latest))) return { ok: false, error: PHOTOS_GONE };
    // The admin repository: the job's columns are the server's to write.
    const admin = await getAdminRepository();
    const job = await admin.createPhotorealJob(user.id, propertyId, { files: source.files, bytes: source.bytes, inputsJobId: source.id });
    if (!job) return { ok: false, error: "Send the scan to Atrium first, then make it AI-enhanced." };
    const address = (await repo.getProperty(user.id, propertyId))?.property.addressLine ?? "your listing";
    const origin = requestOrigin(await headers());
    const pay = await claimOrCheckout(
      () => photorealAccess(user, propertyId),
      (price) =>
        checkoutUrl({
          payer: user,
          price,
          propertyId,
          description: `Photoreal walkthrough: ${address}`,
          origin,
          cancelPath: `/dashboard/properties/${propertyId}`,
        }),
    );
    revalidatePath(`/dashboard/properties/${propertyId}`);
    // Paying starts the waiting job (billing/stripe.ts).
    if (pay) return { ok: false, checkoutUrl: pay };
    const started = await dispatchJob(admin, job, serverBaseUrl(await headers()).url);
    return started.status === "running" ? { ok: true } : { ok: false, error: started.message ?? "The GPU didn't take the job." };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Which version of the photoreal walkthrough buyers see (docs/photoreal.md §3.1): "faithful", made
 * only from the photos, or "ai", cleaned up by the AI where the photos say little.
 */
export async function choosePhotorealVersionAction(propertyId: string, version: "faithful" | "ai"): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const repo = await getRepository();
    const job = await repo.latestPhotorealJob(user.id, propertyId);
    const ai = job?.variants?.ai;
    const url = version === "ai" ? (ai?.status === "done" ? ai.splatUrl : null) : job?.status === "done" ? job.splatUrl : null;
    if (!url) return { ok: false, error: "That version isn't ready." };
    await repo.setSplatUrl(user.id, propertyId, url);
    revalidatePath(`/dashboard/properties/${propertyId}`);
    revalidatePath(`/dashboard/properties/${propertyId}/preview`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Deletes the photos kept for training the listing again (the walkthrough itself stays). */
export async function deletePhotorealPhotosAction(propertyId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const latest = await (await getRepository()).latestPhotorealJob(user.id, propertyId);
    if (!latest) return { ok: false, error: "There are no photos to delete." };
    if (latest.status === "uploading" || latest.status === "queued" || latest.status === "running") {
      return { ok: false, error: "The photos are in use: wait until the walkthrough is ready." };
    }
    const remaster = await (await getRepository()).latestRemasterJob(user.id, propertyId).catch(() => null);
    if (remaster && remasterBusy(remaster) && remaster.inputsJobId === photosJobId(latest)) {
      return { ok: false, error: "The photos are in use: wait until the remastered model is ready." };
    }
    await deletePhotos(await getAdminRepository(), latest);
    revalidatePath(`/dashboard/properties/${propertyId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Remastered models (docs/remaster.md)
// ---------------------------------------------------------------------------

/**
 * Remasters the listing's scan from the photos kept on the server: a new job for the remaster GPU.
 * Covered by the listing's photoreal (one look made from the photos, any version of it); otherwise the
 * realtor pays first, as for photoreal, and it starts once paid.
 */
export async function startRemasterAction(propertyId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const repo = await getRepository();
    const bundle = await repo.getProperty(user.id, propertyId);
    const tour = bundle?.tour;
    if (!tour || tour.source !== "ios_scan" || !tour.cleanAssetUrl) return { ok: false, error: "Remastering works on photo scans from Atrium Capture." };
    const admin = await getAdminRepository();
    const latest = await repo.latestRemasterJob(user.id, propertyId);
    if (latest && latest.tourId === tour.id && latest.status === "running") {
      // A GPU that stopped reporting for hours isn't coming back: that job is written off.
      if (Date.now() - Date.parse(latest.updatedAt) < 3 * 3600_000) return { ok: false, error: "The remastered model is already on its way." };
      await admin.updateRemasterJob(latest.id, { status: "failed", stage: null, message: "The GPU stopped reporting.", finishedAt: new Date().toISOString() });
    }
    if (!remasterConfigured()) return { ok: false, error: WAITING_FOR_REMASTER_GPU };
    const upload = await photosForRemaster(repo, user.id, propertyId, tour);
    if (!upload) return { ok: false, error: NO_PHOTOS };
    const origin = requestOrigin(await headers());
    const pay = await claimOrCheckout(
      () => photorealAccess(user, propertyId),
      (price) =>
        checkoutUrl({
          payer: user,
          price,
          propertyId,
          description: `Remastered model: ${bundle!.property.addressLine}`,
          origin,
          cancelPath: `/dashboard/properties/${propertyId}`,
          start: "remaster",
        }),
    );
    if (pay) return { ok: false, checkoutUrl: pay };
    // The admin repository: the job's columns are the server's to write.
    const started = await queueRemaster(admin, user.id, propertyId, tour, upload, serverBaseUrl(await headers()).url);
    if (!started) return { ok: false, error: "The remastered model is already on its way." };
    revalidatePath(`/dashboard/properties/${propertyId}`);
    return started.status === "running" ? { ok: true } : { ok: false, error: started.message ?? "The GPU didn't take the job." };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// iPhone capture pairing (docs/iphone-capture.md §3.1)
// ---------------------------------------------------------------------------

export interface PhonePairing {
  /** atriumcapture://pair?server=…&token=… */
  deepLink: string;
  /** The deep link as a QR code (SVG data URL). */
  qrCode: string;
  /** Where the phone will upload. */
  serverUrl: string;
  /** The server is only reachable on the local network (same Wi-Fi). */
  lan: boolean;
  /** A Vercel preview deployment: with Deployment Protection on, the phone gets its login wall (401). */
  preview: boolean;
  expiresAt: string;
}

/** Start a capture session: a one-day pairing code the iPhone app scans to upload into this listing. */
export async function createCaptureSessionAction(propertyId: string): Promise<ActionResult & { pairing?: PhonePairing }> {
  const user = await requireUser();
  if (storageMode() === "ephemeral") return { ok: false, error: "Connect a database first — this deployment can't keep uploads yet (see /setup)." };
  const unavailable = adminRepositoryUnavailableReason();
  if (unavailable) return { ok: false, error: unavailable };
  try {
    const { token, tokenHash } = newCaptureToken();
    const expiresAt = new Date(Date.now() + CAPTURE_SESSION_TTL_MS).toISOString();
    await (await getRepository()).createCaptureSession(user.id, propertyId, { tokenHash, expiresAt });
    const server = serverBaseUrl(await headers());
    const deepLink = pairingDeepLink(server.url, token);
    const svg = await QRCode.toString(deepLink, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#161514", light: "#ffffff" } });
    return {
      ok: true,
      pairing: { deepLink, qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, serverUrl: server.url, lan: server.lan, preview: process.env.VERCEL_ENV === "preview" && !process.env.NEXT_PUBLIC_SITE_URL, expiresAt },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** What the cover maker renders for a listing with a tour and no cover yet (null: nothing to do). */
export async function coverSourceAction(propertyId: string): Promise<TourData | null> {
  const user = await requireUser();
  const bundle = await (await getRepository()).getProperty(user.id, propertyId);
  if (!bundle || bundle.property.coverImageUrl) return null;
  return bundleToTourData(bundle);
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
