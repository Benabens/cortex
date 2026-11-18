import type { MetadataRoute } from "next";
import { getLocale, getT } from "@/lib/i18n/server";

/**
 * Manifest (écran d'accueil Android / Chrome). Les icônes vivent dans
 * public/brand/ ; les couleurs reprennent le fond de l'app (--color-bg), la même
 * valeur que `themeColor` du layout. Servi sans session : voir PUBLIC_FILES du proxy.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const locale = await getLocale();
  const t = await getT("manifest");
  return {
    // i18n-allow: nom de marque
    name: "Cortex",
    short_name: t("shortName"),
    description: t("description"),
    lang: locale,
    start_url: "/",
    display: "standalone",
    background_color: "#080c14",
    theme_color: "#080c14",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
