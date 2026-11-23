import type { MetadataRoute } from "next";

/**
 * L'app est privée : rien à crawler sauf l'écran de connexion et la page de l'outil gratuit
 * (cf. lib/seo) ; ses résultats (/whats-on-my-exam/r/…) restent en noindex.
 * Aucun sitemap annoncé ici — c'est la vitrine qui en publie un.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/", allow: ["/login", "/whats-on-my-exam"] }],
  };
}
