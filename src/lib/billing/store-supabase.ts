import "server-only";
import { supabaseAdminKey } from "@/lib/data/config";
import { withMigrations } from "@/lib/data/supabase-store";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { GrantKind, Plan } from "./plans";
import type { BillingStore, Grant, GrantSource, NewGrant, SubscriptionRecord } from "./store";

// Supabase: the billing tables (supabase/migrations/…_billing.sql), written only through the
// service-role client. It bypasses RLS, so every query names the realtor it's for.

interface SubscriptionRow {
  id: string;
  user_id: string;
  customer_id: string;
  plan: Plan;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

interface GrantRow {
  id: string;
  user_id: string;
  property_id: string | null;
  kind: GrantKind;
  source: GrantSource;
  reference: string;
  amount_cents: number;
  created_at: string;
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

const toSubscription = (r: SubscriptionRow): SubscriptionRecord => ({
  id: r.id,
  userId: r.user_id,
  customerId: r.customer_id,
  plan: r.plan,
  status: r.status,
  currentPeriodStart: r.current_period_start,
  currentPeriodEnd: r.current_period_end,
  cancelAtPeriodEnd: r.cancel_at_period_end,
  updatedAt: r.updated_at,
});

const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  userId: r.user_id,
  propertyId: r.property_id,
  kind: r.kind,
  source: r.source,
  reference: r.reference,
  amountCents: r.amount_cents,
  createdAt: r.created_at,
});

export class SupabaseBillingStore implements BillingStore {
  private db() {
    if (!supabaseAdminKey()) throw new Error("Billing needs SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in the server's environment variables.");
    return createSupabaseAdminClient();
  }

  customerId(userId: string) {
    return withMigrations(async () => {
      const row = check(await this.db().from("billing_customers").select("id").eq("user_id", userId).maybeSingle()) as { id: string } | null;
      return row?.id ?? null;
    });
  }

  saveCustomer(userId: string, customerId: string) {
    return withMigrations(async () => {
      check(await this.db().from("billing_customers").upsert({ id: customerId, user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true }));
    });
  }

  userForCustomer(customerId: string) {
    return withMigrations(async () => {
      const row = check(await this.db().from("billing_customers").select("user_id").eq("id", customerId).maybeSingle()) as { user_id: string } | null;
      return row?.user_id ?? null;
    });
  }

  subscriptions(userId: string) {
    return withMigrations(async () => {
      const rows = check(
        await this.db().from("billing_subscriptions").select("*").eq("user_id", userId).order("updated_at", { ascending: false }),
      ) as SubscriptionRow[];
      return rows.map(toSubscription);
    });
  }

  saveSubscription(sub: SubscriptionRecord) {
    return withMigrations(async () => {
      check(
        await this.db().from("billing_subscriptions").upsert(
          {
            id: sub.id,
            user_id: sub.userId,
            customer_id: sub.customerId,
            plan: sub.plan,
            status: sub.status,
            current_period_start: sub.currentPeriodStart,
            current_period_end: sub.currentPeriodEnd,
            cancel_at_period_end: sub.cancelAtPeriodEnd,
            updated_at: sub.updatedAt,
          },
          { onConflict: "id" },
        ),
      );
    });
  }

  grants(userId: string, filter: { propertyId?: string; kind?: GrantKind } = {}) {
    return withMigrations(async () => {
      let q = this.db().from("billing_grants").select("*").eq("user_id", userId);
      if (filter.propertyId) q = q.eq("property_id", filter.propertyId);
      if (filter.kind) q = q.eq("kind", filter.kind);
      return (check(await q.order("created_at", { ascending: false })) as GrantRow[]).map(toGrant);
    });
  }

  addGrant(grant: NewGrant) {
    return withMigrations(async () => {
      const inserted = check(
        await this.db()
          .from("billing_grants")
          .upsert(
            {
              user_id: grant.userId,
              property_id: grant.propertyId,
              kind: grant.kind,
              source: grant.source,
              reference: grant.reference,
              amount_cents: grant.amountCents,
            },
            { onConflict: "reference", ignoreDuplicates: true },
          )
          .select("id"),
      ) as { id: string }[] | null;
      return !!inserted?.length;
    });
  }

  start() {
    return withMigrations(async () => {
      check(await this.db().rpc("billing_start"));
    });
  }
}
