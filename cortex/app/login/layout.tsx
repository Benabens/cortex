import type { Metadata } from "next";
import { publicOrigin } from "@/lib/public-url";
import { INDEXABLE } from "@/lib/seo";
import { getLocale, getT } from "@/lib/i18n/server";

/**
 * Métadonnées de partage. /login est la seule page que voient un visiteur anonyme
 * et un robot de prévisualisation (tout le reste redirige ici), d'où l'image de
 * partage dans ce segment (opengraph-image.png ; X la reprend faute de
 * twitter:image). La page est dynamique : AUTH_URL (l'URL publique, posée en
 * prod) est lue à la requête ; sans elle, Next résout l'image vers
 * http://localhost:3000. Layout dédié plutôt qu'un export dans page.tsx ou le
 * layout racine : la branche antislop-ui réécrit ces deux fichiers.
 */
/** URL publique ; une valeur absente ou mal formée ne doit pas casser /login. */
function metadataBase(): URL | undefined {
  const origin = publicOrigin();
  return origin ? new URL(origin) : undefined;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("login");
  const locale = await getLocale();
  const title = t("shareTitle");
  const description = t("shareDescription");
  return {
  // Seule page publique de l'app : elle reste indexable (cf. lib/seo).
  ...INDEXABLE,
  metadataBase: metadataBase(),
  openGraph: {
    type: "website",
    // i18n-allow: nom de marque
    siteName: "Cortex",
    locale: locale === "fr" ? "fr_FR" : "en_GB",
    title,
    description,
  },
  twitter: { card: "summary_large_image", title, description },
  };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
