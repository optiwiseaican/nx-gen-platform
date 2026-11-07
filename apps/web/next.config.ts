import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NxGen runs fully offline on the lab workstation: the UI is exported as static
  // files and served by the local NestJS service / Electron shell — no Next.js server.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // The dev-only badge covers the phone navigation button.
  devIndicators: false,
};

export default nextConfig;
