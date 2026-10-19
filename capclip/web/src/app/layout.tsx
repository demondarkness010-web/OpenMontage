import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui";
import "./globals.css";

// Fonts are fetched by the browser (with system-font fallbacks) rather than at
// build time, so builds never depend on network access to Google Fonts.
const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap";

export const metadata: Metadata = {
  title: { default: "CapClip — One Video. Endless Shorts.", template: "%s · CapClip" },
  description: "CapClip turns one long video into ready-to-publish vertical Shorts with clean pacing, fresh captions and accurate titles.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#0a0a0d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body className="min-h-screen font-sans">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
