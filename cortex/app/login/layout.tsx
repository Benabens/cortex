import type { Metadata } from "next";
import { publicOrigin } from "@/lib/public-url";
import { INDEXABLE } from "@/lib/seo";

/**
 * Métadonnées de partage. /login est la seule page que voient un visiteur anonyme
 * et un robot de prévisualisation (tout le reste redirige ici), d'où l'image de
 * partage dans ce segment (opengraph-image.png ; X la reprend faute de
 * twitter:image). La page est dynamique : AUTH_URL (l'URL publique, posée en
 * prod) est lue à la requête ; sans elle, Next résout l'image vers
 * http://localhost:3000. Layout dédié plutôt qu'un export dans page.tsx ou le
 * layout racine : la branche antislop-ui réécrit ces deux fichiers.
 */
const SHARE_TITLE = "Cortex : révise ce qui tombe vraiment";
const SHARE_DESCRIPTION =
  "Cortex lit tes annales et tes slides, repère ce qui revient, et t’entraîne dessus avant le jour J.";

/** URL publique ; une valeur absente ou mal formée ne doit pas casser /login. */
function metadataBase(): URL | undefined {
  const origin = publicOrigin();
  return origin ? new URL(origin) : undefined;
}

export const metadata: Metadata = {
  // Seule page publique de l'app : elle reste indexable (cf. lib/seo).
  ...INDEXABLE,
  metadataBase: metadataBase(),
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
