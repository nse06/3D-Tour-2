import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
