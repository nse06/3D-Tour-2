import "server-only";
import { listingAccess, type Payer } from "./access";
import { dollars, PLAN_NAMES, PRICES, type PublishPricing } from "./plans";

// What the listing page says a listing's next step costs. The answer is checked again when the
// realtor acts, so a page left open can't publish anything for free.

export async function publishPricing(payer: Payer, propertyId: string): Promise<PublishPricing | null> {
  const access = await listingAccess(payer, propertyId);
  if (!access.allowed) {
    return {
      label: `Publish tour — ${dollars(access.amount)}`,
      note: `One-time, for this listing. Or publish every listing for ${dollars(PRICES.unlimited.amount)}/month.`,
      plans: true,
    };
  }
  switch (access.reason) {
    case "first-listing":
      return { label: "Publish tour — free", note: "Your first listing is on us.", plans: false };
    case "plan":
      return access.plan ? { label: "Publish tour", note: `Included in your ${PLAN_NAMES[access.plan.plan]} plan.`, plans: false } : null;
    default:
      return null;
  }
}
