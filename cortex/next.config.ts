import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 est un module natif : ne pas le bundler côté serveur.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
