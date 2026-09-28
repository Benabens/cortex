import type { MetadataRoute } from "next";

/**
 * Manifest (écran d'accueil Android / Chrome). Les icônes vivent dans
 * public/brand/ ; les couleurs reprennent le fond de l'app (--color-bg), la même
 * valeur que `themeColor` du layout. Servi sans session : voir PUBLIC_FILES du proxy.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cortex",
    short_name: "Cortex",
    description: "Révise ce qui tombe vraiment.",
    lang: "fr",
    start_url: "/",
    display: "standalone",
    background_color: "#0c0d15",
    theme_color: "#0c0d15",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
