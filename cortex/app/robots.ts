import type { MetadataRoute } from "next";
import { freeToolEnabled } from "@/lib/exam-topics/config";

/**
 * L'app est privée : rien à crawler sauf l'écran de connexion et, si l'outil gratuit est
 * activé (FREE_TOOL_ENABLED, cf. lib/exam-topics/config), sa page (cf. lib/seo) ; ses résultats
 * (/whats-on-my-exam/r/…) restent en noindex. Aucun sitemap annoncé ici — c'est la vitrine qui en publie un.
 */
export default function robots(): MetadataRoute.Robots {
  const allow = freeToolEnabled() ? ["/login", "/whats-on-my-exam"] : ["/login"];
  return {
    rules: [{ userAgent: "*", disallow: "/", allow }],
  };
}
