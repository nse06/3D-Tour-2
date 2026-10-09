import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let phones and other computers on the same network use the dev server
  // (e.g. opening http://192.168.1.20:3000 while testing iPhone capture).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
  // The /setup page shows the SQL migrations, and the iPhone upload and photoreal jobs add the
  // tables and columns newer migrations introduce, so they ship them with their serverless bundles.
  outputFileTracingIncludes: {
    "/setup": ["./supabase/migrations/*.sql"],
    "/api/capture/sessions/*/complete": ["./supabase/migrations/*.sql"],
    "/api/capture/sessions/*/photoreal": ["./supabase/migrations/*.sql"],
    "/api/capture/sessions/*/photoreal/*": ["./supabase/migrations/*.sql"],
    "/api/photoreal/jobs/*": ["./supabase/migrations/*.sql"],
    "/api/properties/*/photoreal": ["./supabase/migrations/*.sql"],
    "/dashboard/properties/*": ["./supabase/migrations/*.sql"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
