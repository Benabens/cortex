import type { NextConfig } from "next";
import { GLOBAL_HEADERS_SOURCE, SECURITY_HEADERS } from "./lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // better-sqlite3 est un module natif : ne pas le bundler côté serveur.
  // @electric-sql/pglite embarque des assets WASM que le bundler perd
  // (« /ROOT/…/pglite.data ») — requis externe pour le mode pglite:// sous
  // `next start` (démo/E2E prod-like sans Docker). Chargé lazy : absent en
  // prod (devDependency élaguée) tant que DATABASE_URL n'est pas pglite://.
  // isomorphic-dompurify tire jsdom (dépendances optionnelles natives) : externe.
  serverExternalPackages: ["better-sqlite3", "@electric-sql/pglite", "isomorphic-dompurify"],
  // En-têtes de sécurité sur toutes les réponses SAUF les routes de fichiers,
  // qui posent les leurs (bac à sable du HTML importé) — cf. lib/security-headers.
  async headers() {
    return [{ source: GLOBAL_HEADERS_SOURCE, headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
