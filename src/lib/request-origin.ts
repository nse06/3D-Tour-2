/**
 * The site's address as the visitor's browser sees it (a proxy's forwarded host first), for links
 * that must come back to the same site and its cookies, such as Stripe's return page.
 */
export function requestOrigin(headers: Headers): string {
  const first = (value: string | null) => value?.split(",")[0]?.trim() ?? "";
  const host = first(headers.get("x-forwarded-host")) || headers.get("host") || "localhost:3000";
  const forwarded = first(headers.get("x-forwarded-proto"));
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
  return `${proto}://${host}`;
}
