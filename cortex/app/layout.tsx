import type { Metadata, Viewport } from "next";
import { Funnel_Display } from "next/font/google";
import "./globals.css";
import "./legacy-compat.css";
import { AppShell } from "@/components/shell/AppShell";
import { legalLinks } from "@/lib/legal";

// Typo (décision 2026-09-28) : Funnel Display pour les titres et le wordmark ;
// l'interface est en police système (aucune autre police chargée).
const funnelDisplay = Funnel_Display({
  variable: "--font-funnel-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "cortex · révise ce qui tombe vraiment",
  description:
    "Cortex : apprentissage par répétition espacée. Sais toujours quoi réviser ensuite.",
};

export const viewport: Viewport = {
  themeColor: "#0c0d15",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="fr"
      className={`${funnelDisplay.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <AppShell legal={legalLinks()}>{children}</AppShell>
      </body>
    </html>
  );
}
