import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let phones and other computers on the same network use the dev server
  // (e.g. opening http://192.168.1.20:3000 while testing iPhone capture).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
  // The /setup page shows the SQL migrations, so they must ship with the serverless bundle.
  outputFileTracingIncludes: {
    "/setup": ["./supabase/migrations/*.sql"],
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
