import type { NextConfig } from "next";

const API = process.env.CAPCLIP_API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  // The browser only ever talks to this origin; API + signed media are proxied
  // to the FastAPI backend, so cookies and video stay same-origin (needed for
  // canvas-based live preview).
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/media/:path*", destination: `${API}/media/:path*` },
    ];
  },
  images: { remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }] },
  poweredByHeader: false,
};

export default nextConfig;
