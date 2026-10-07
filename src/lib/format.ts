export function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatBaths(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function cityLine(p: { city: string; state: string; postalCode?: string }): string {
  return [p.city, [p.state, p.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}
