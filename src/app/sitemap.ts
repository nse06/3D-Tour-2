import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

/** The public marketing pages (listings' own walkthroughs are shared by link, not listed here). */
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/how-it-works", "/pricing", "/faq", "/tour/sample"].map((path) => ({
    url: `${siteUrl}${path}`,
    changeFrequency: "monthly",
    priority: path === "" ? 1 : 0.7,
  }));
}
