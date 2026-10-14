import type { NextConfig } from "next";

// Kept deliberately plain: every page that shows workspace data is rendered
// per request for the signed-in user, so Cache Components is off for now.
const nextConfig: NextConfig = {
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
