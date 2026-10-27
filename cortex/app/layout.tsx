import type { Metadata, Viewport } from "next";
import { Funnel_Display } from "next/font/google";
import "./globals.css";
import "./legacy-compat.css";
import { AppShell } from "@/components/shell/AppShell";
import { contactEmail } from "@/lib/contact";
import { legalEnglishUrl, legalLinks } from "@/lib/legal";
import { NOINDEX } from "@/lib/seo";
import { THEME_COLORS, THEME_INIT_SCRIPT } from "@/lib/ux/theme";

// Typo (décision 2026-09-28) : Funnel Display pour les titres et le wordmark ;
// l'interface est en police système (aucune autre police chargée).
const funnelDisplay = Funnel_Display({
  variable: "--font-funnel-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  // Surface privée : aucune page authentifiée ne doit être indexée (cf. lib/seo).
  ...NOINDEX,
  title: "cortex · révise ce qui tombe vraiment",
  description:
    "Cortex : apprentissage par répétition espacée. Sais toujours quoi réviser ensuite.",
};

export const viewport: Viewport = {
  // Couleur de la barre du navigateur selon le système ; un choix explicite (Compte, barre du
  // haut) la réécrit côté client (lib/ux/use-theme).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
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
      // data-theme est posé par le script ci-dessous avant l'hydratation : React ne doit pas s'en offusquer.
      suppressHydrationWarning
    >
      <head>
        {/* Thème (sombre / clair / système) posé avant le premier rendu : aucun flash. */}
        <script>{THEME_INIT_SCRIPT}</script>
      </head>
      <body className="min-h-full">
        <AppShell legal={legalLinks()} legalEnglish={legalEnglishUrl()} contact={contactEmail()}>{children}</AppShell>
      </body>
    </html>
  );
}
