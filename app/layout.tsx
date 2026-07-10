import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "J.A.R.V.I.S.",
  description: "Voice-driven tasks, notes, calendar and email assistant",
  manifest: "/manifest.webmanifest",
  // app/icon.svg is auto-detected by Next for the favicon; declare apple-touch
  // explicitly so iOS home-screen installs get the orb too.
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#b7afd2",
  width: "device-width",
  initialScale: 1,
  // Allow pinch-zoom — capping maximumScale at 1 locks zoom out, which hurts
  // usability/accessibility on phones (the main reason the app felt "unscalable").
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
