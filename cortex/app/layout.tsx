import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter } from "next/font/google";
import "./globals.css";
import "./legacy-compat.css";
import { AppShell } from "@/components/shell/AppShell";
import { legalLinks } from "@/lib/legal";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "cortex — révise ce qui tombe vraiment",
  description:
    "Cortex — apprentissage par répétition espacée. Sais toujours quoi réviser ensuite.",
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
      className={`${spaceGrotesk.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <AppShell legal={legalLinks()}>{children}</AppShell>
      </body>
    </html>
  );
}
