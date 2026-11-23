import type { Metadata, Viewport } from "next";
import { Funnel_Display } from "next/font/google";
import "./globals.css";
// Formules (components/ui/MathText) : polices servies par l'app, chargées seulement quand une formule s'affiche
import "katex/dist/katex.min.css";
import "@/components/ui/math.css";
import "./legacy-compat.css";
import { AppShell } from "@/components/shell/AppShell";
import { ErrorTracking } from "@/components/ErrorTracking";
import { IntlProvider } from "@/components/i18n/IntlProvider";
import { MESSAGES } from "@/lib/i18n/messages";
import { getRequestLocale, getT } from "@/lib/i18n/server";
import { contactEmail } from "@/lib/contact";
import { legalEnglishUrl, legalLinks } from "@/lib/legal";
import { NOINDEX } from "@/lib/seo";
import { THEME_COLORS, THEME_INIT_SCRIPT } from "@/lib/ux/theme";

// Funnel Display pour le logo uniquement ; Inter local pour toute l’interface.
const funnelDisplay = Funnel_Display({
  variable: "--font-funnel-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("meta");
  // Surface privée : aucune page authentifiée ne doit être indexée (cf. lib/seo).
  return { ...NOINDEX, title: t("title"), description: t("description") };
}

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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Langue du compte, sinon du sélecteur, sinon du navigateur (lib/i18n/locale) : `lang` fait
  // lire l'interface avec la bonne voix ; le contenu d'un cours porte la sienne (WCAG 3.1.2).
  const { locale, fromAccount } = await getRequestLocale();
  return (
    <html
      lang={locale}
      className={`${funnelDisplay.variable} h-full antialiased`}
      // data-theme est posé par le script ci-dessous avant l'hydratation : React ne doit pas s'en offusquer.
      suppressHydrationWarning
    >
      <head>
        {/* Thème (sombre / clair / système) posé avant le premier rendu : aucun flash. */}
        <script>{THEME_INIT_SCRIPT}</script>
      </head>
      <body className="min-h-full">
        {/* Suivi d'erreurs du navigateur : sans SENTRY_DSN, rien n'est téléchargé. */}
        <ErrorTracking />
        <IntlProvider locale={locale} messages={MESSAGES[locale]} syncCookie={fromAccount}>
          <AppShell legal={legalLinks()} legalEnglish={legalEnglishUrl()} contact={contactEmail()}>{children}</AppShell>
        </IntlProvider>
      </body>
    </html>
  );
}
