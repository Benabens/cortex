/**
 * EN-TÊTES DE SÉCURITÉ — source unique pour next.config.ts (règle globale) et
 * pour les routes qui servent des FICHIERS (lib : `servedFileHeaders`).
 *
 * Pourquoi deux voies : la règle globale de next.config ÉCRASE l'en-tête de
 * même nom posé par une route (vérifié sur le serveur buildé). Or un .html
 * importé — une annale « trouvée en ligne » — est rendu sur l'origine de
 * l'app par /refs et /csrc : un script qu'il contient tournerait avec la
 * session de l'étudiant, et le sanitizer (réservé au HTML du modèle) ne le
 * voit jamais. Ces routes doivent donc pouvoir poser `CSP: sandbox` sur le
 * HTML, et PAS sur les PDF (le viewer natif n'aime pas le sandbox) : elles
 * sont exclues de la règle globale et posent elles-mêmes le jeu complet.
 *
 * La CSP de base est défensive, pas hermétique : Next livre son bootstrap et
 * le flux RSC en <script> inline, Tailwind/next-font et le HTML d'examen posent
 * des styles inline → 'unsafe-inline' reste nécessaire (le rempart contre le
 * XSS du HTML modèle est lib/sanitize-html). Ce que la CSP interdit vraiment :
 * charger un script d'une autre origine, exfiltrer via fetch/XHR/WebSocket
 * (connect-src), <object>/<embed> externes, <base> détourné, et l'embarquement
 * de l'app dans une iframe tierce. En dev, 'unsafe-eval' est requis par HMR.
 * form-action : après le POST du formulaire de connexion, Auth.js redirige vers
 * Google — Chrome applique form-action aux redirections.
 */
const isProd = process.env.NODE_ENV === "production";

export const CSP_BASE = [
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

/** Bac à sable d'un document HTML importé : aucun script, aucun formulaire, origine opaque. */
export const CSP_SANDBOXED_HTML = "sandbox; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: CSP_BASE },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Ignoré en HTTP clair (dev). En prod derrière le TLS de la plateforme, épingle
  // HTTPS pour l'hôte servi et ses sous-domaines (aucun aujourd'hui).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/** Routes de fichiers : exclues de la règle globale, elles posent leurs en-têtes elles-mêmes. */
export const SERVED_FILE_PREFIXES = ["/refs/", "/csrc", "/exam/", "/uploads/"] as const;

/** Source path-to-regexp de la règle globale de next.config (tout sauf les routes de fichiers). */
export const GLOBAL_HEADERS_SOURCE = `/((?!${SERVED_FILE_PREFIXES.map((p) => p.slice(1)).join("|")}).*)`;

export function isServedFilePath(pathname: string): boolean {
  return SERVED_FILE_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * En-têtes d'une réponse FICHIER : le jeu de sécurité complet, avec la CSP
 * remplacée par le bac à sable quand le contenu est du HTML.
 */
export function servedFileHeaders(contentType: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "content-type": contentType, ...extra };
  const html = /^text\/html\b/i.test(contentType);
  for (const h of SECURITY_HEADERS) {
    headers[h.key.toLowerCase()] = h.key === "Content-Security-Policy" && html ? CSP_SANDBOXED_HTML : h.value;
  }
  return headers;
}
