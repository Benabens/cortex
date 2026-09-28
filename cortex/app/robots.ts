import type { MetadataRoute } from "next";

/**
 * L'app est privée : rien à crawler sauf l'écran de connexion (cf. lib/seo).
 * Aucun sitemap annoncé ici — c'est la vitrine qui en publie un.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/", allow: "/login" }],
  };
}
