import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NxGen runs fully offline on the lab workstation: the UI is exported as static
  // files and served by the local NestJS service / Electron shell — no Next.js server.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
