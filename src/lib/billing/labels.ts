import "server-only";
import { listingAccess, photorealAccess, proPhotorealUsed, type Payer } from "./access";
import { dollars, PLAN_NAMES, PRICES, PRO_PHOTOREAL_INCLUDED, type PhotorealPricing, type PublishPricing } from "./plans";

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

export async function photorealPricing(payer: Payer, propertyId: string): Promise<PhotorealPricing | null> {
  const access = await photorealAccess(payer, propertyId);
  if (!access.allowed) {
    const pro = access.price === "photorealPro";
    return {
      note: pro
        ? `${dollars(access.amount)} for this listing: this month's ${PRO_PHOTOREAL_INCLUDED} Pro listings are used.`
        : `${dollars(access.amount)} for this listing, paid here once the photos are in. Pro includes ${PRO_PHOTOREAL_INCLUDED} a month.`,
      pay: true,
      payLabel: `Add photoreal — ${dollars(access.amount)}`,
    };
  }
  const free = (note: string | null): PhotorealPricing => ({ note, pay: false, payLabel: "" });
  switch (access.reason) {
    case "beta":
      return free("Free during the beta.");
    case "paid":
      return free("Paid for this listing: training it again costs nothing.");
    case "pro-included": {
      const left = PRO_PHOTOREAL_INCLUDED - (access.plan ? await proPhotorealUsed(payer.id, access.plan) : 0);
      return free(`Included in Pro: ${left} of ${PRO_PHOTOREAL_INCLUDED} left this month.`);
    }
    default:
      return null;
  }
}
