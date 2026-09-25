import type { NextConfig } from "next";

/**
 * EN-TÊTES DE SÉCURITÉ, sur toutes les réponses (pages, API, fichiers servis).
 *
 * La CSP est défensive, pas hermétique : Next livre son bootstrap et le flux
 * RSC en <script> inline, Tailwind/next-font et le HTML d'examen posent des
 * styles inline → 'unsafe-inline' reste nécessaire sur script-src/style-src
 * (le rempart contre le XSS du HTML modèle est le sanitizer, cf.
 * lib/sanitize-html). Ce que la CSP interdit vraiment : charger un script
 * depuis une autre origine, exfiltrer via fetch/XHR/WebSocket (connect-src),
 * <object>/<embed> externes, <base> détourné, et l'embarquement de l'app dans
 * une iframe tierce (clickjacking). En dev, 'unsafe-eval' est requis par HMR.
 * form-action : après le POST du formulaire de connexion, Auth.js redirige vers
 * Google — Chrome applique form-action aux redirections.
 */
const isProd = process.env.NODE_ENV === "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'self'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Ignoré en HTTP clair (dev) ; en prod derrière le TLS de la plateforme, épingle HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // better-sqlite3 est un module natif : ne pas le bundler côté serveur.
  // @electric-sql/pglite embarque des assets WASM que le bundler perd
  // (« /ROOT/…/pglite.data ») — requis externe pour le mode pglite:// sous
  // `next start` (démo/E2E prod-like sans Docker). Chargé lazy : absent en
  // prod (devDependency élaguée) tant que DATABASE_URL n'est pas pglite://.
  // isomorphic-dompurify tire jsdom (dépendances optionnelles natives) : externe.
  serverExternalPackages: ["better-sqlite3", "@electric-sql/pglite", "isomorphic-dompurify"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
