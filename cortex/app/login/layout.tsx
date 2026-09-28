import type { Metadata } from "next";

/**
 * Métadonnées de partage. /login est la seule page que voient un visiteur anonyme
 * et un robot de prévisualisation (tout le reste redirige ici), d'où l'image de
 * partage dans ce segment (opengraph-image.png, twitter-image.png). La page est
 * dynamique : AUTH_URL (l'URL publique, posée en prod) est lue à la requête. Sans
 * elle, Next résout l'image vers http://localhost:3000.
 */
const SHARE_TITLE = "Cortex : révise ce qui tombe vraiment";
const SHARE_DESCRIPTION =
  "Cortex lit tes annales et tes slides, repère ce qui revient, et t’entraîne dessus avant le jour J.";

export const metadata: Metadata = {
  metadataBase: process.env.AUTH_URL ? new URL(process.env.AUTH_URL) : undefined,
  openGraph: {
    type: "website",
    siteName: "Cortex",
    locale: "fr_FR",
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
  },
  twitter: { card: "summary_large_image", title: SHARE_TITLE, description: SHARE_DESCRIPTION },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
