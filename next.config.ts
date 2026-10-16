import type { NextConfig } from "next";

// Kept deliberately plain: every page that shows workspace data is rendered
// per request for the signed-in user, so Cache Components is off for now.
const nextConfig: NextConfig = {
  // The messaging brain reads its instructions file at runtime (it's data,
  // versioned in the repo); make sure the serverless trace carries it.
  outputFileTracingIncludes: {
    "/*": ["src/modules/messaging/brain/*.md"],
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
