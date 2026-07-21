import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 est un module natif : ne pas le bundler côté serveur.
  // @electric-sql/pglite embarque des assets WASM que le bundler perd
  // (« /ROOT/…/pglite.data ») — requis externe pour le mode pglite:// sous
  // `next start` (démo/E2E prod-like sans Docker). Chargé lazy : absent en
  // prod (devDependency élaguée) tant que DATABASE_URL n'est pas pglite://.
  serverExternalPackages: ["better-sqlite3", "@electric-sql/pglite"],
};

export default nextConfig;
