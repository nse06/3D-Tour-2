import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { billingEnabled } from "@/lib/billing/config";
import { applyCheckoutSession, stripe } from "@/lib/billing/stripe";
import { serverBaseUrl } from "@/lib/capture-sessions";

/**
 * Where Stripe's checkout sends the realtor after paying: records the payment right away (the
 * webhook may arrive later, or not at all on a site without one) and opens what they paid for.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const go = (path: string) => NextResponse.redirect(new URL(path, url.origin));
  const sessionId = url.searchParams.get("session_id") ?? "";
  const user = await getCurrentUser();
  if (!user) return go("/login?next=/dashboard/billing");
  if (!billingEnabled() || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return go("/dashboard/billing");
  try {
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    // Someone else's checkout: nothing to show here.
    if (session.metadata?.userId !== user.id) return go("/dashboard/billing");
    const applied = await applyCheckoutSession(session, serverBaseUrl(request.headers).url);
    if (!applied) return go("/dashboard/billing");
    if (applied.kind === "plan") return go(`/dashboard/billing?subscribed=${applied.plan ?? "1"}`);
    return go(`/dashboard/properties/${applied.propertyId}?paid=${applied.pending ? "pending" : applied.kind}`);
  } catch (e) {
    console.error("billing return:", (e as Error).message);
    return go("/dashboard/billing?error=return");
  }
}
