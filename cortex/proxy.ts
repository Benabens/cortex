import { authBodyLimit } from "@/lib/auth-body-limit";
import { clientIp } from "@/lib/client-ip";
import { demoReadable } from "@/lib/demo-paths";
import { MCP_CARD_PATHS, MCP_ICON_PATHS } from "@/lib/mcp/identity";
import { legacyHostRedirect } from "@/lib/public-url";
import { apiError } from "@/lib/i18n/api-error";
import { localeCookie } from "@/lib/i18n/locale";
import { isToolPath, toolLocale, withLocaleCookie } from "@/lib/exam-topics/locale";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * PROXY Next 16 (ex-middleware) — garde d'authentification OPT-IN.
 *
 * AUTH_ENABLED non posé (défaut) : passage direct, utilisateur implicite
 * « owner » — comportement historique mono-user, dev €0, AUCUNE dépendance
 * auth chargée.
 *
 * AUTH_ENABLED=1 : toute route (pages + API) exige une session ; l'id
 * utilisateur est transmis aux handlers par le header INTERNE `x-cortex-user`
 * (toujours strippé de la requête entrante — anti-usurpation), lu par
 * lib/req.ts → contexte AsyncLocalStorage {user, course} → tenant DB.
 */

const AUTH_ON = process.env.AUTH_ENABLED === "1";

// /verify-request et /signout : atteintes AVANT ou PENDANT la perte de session (lien
// magique envoyé, déconnexion en cours) — jamais de session à ce moment-là.
const PUBLIC_PREFIXES = ["/api/auth", "/api/e2e-llm", "/login", "/verify-request", "/signout", "/api/health", "/api/relais", "/api/metrics", "/api/billing/webhook", "/api/ops/railway-webhook", "/_next", "/favicon", "/brand/",
  // Outil gratuit sans compte (lib/exam-topics) : page, résultats partageables et son API.
  "/whats-on-my-exam", "/api/exam-topics"];

/** Icônes et manifest (fichiers de métadonnées Next) : lus SANS session par
 *  l'onglet et l'écran d'accueil. Égalité stricte : un préfixe « /icon » ouvrirait
 *  tout futur chemin qui commence ainsi. Les PNG du manifest sont sous
 *  public/brand/ ; l'image de partage est sous /login (déjà public). */
// /robots.txt doit être lisible SANS session : redirigé vers /login, il n'atteindrait
// jamais les moteurs et l'app resterait crawlable (cf. app/robots.ts, lib/seo).
const PUBLIC_FILES = new Set(["/icon.svg", "/apple-icon.png", "/manifest.webmanifest", "/robots.txt", ...MCP_ICON_PATHS]);

/**
 * CONNECTEUR MCP (docs/MCP.md) : un client MCP n'a pas de cookie de session. Le
 * point /mcp vérifie lui-même son jeton Bearer (401 + WWW-Authenticate, que la
 * découverte OAuth exige — une redirection vers /login la casserait) ; les
 * métadonnées et les points OAuth machine-à-machine sont publics par nature.
 * L'écran de consentement /oauth/authorize, lui, reste DERRIÈRE la session :
 * c'est là que la personne se connecte avec son compte Cortex. Égalité stricte,
 * jamais de préfixe (« /mcp-… » ou « /oauth/… » futurs restent gardés).
 */
const MCP_PUBLIC = new Set([
  "/mcp",
  // Carte du serveur (SEP-2127) : lue avant toute connexion, par un annuaire ou un client.
  ...MCP_CARD_PATHS,
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
]);

/** Chemin servi SANS session (les handlers font leur propre contrôle, s'il y en a un). */
export function publicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || PUBLIC_FILES.has(pathname) || MCP_PUBLIC.has(pathname);
}

/**
 * CHEMINS HÉRITÉS DU MONO-USER, absents en production : `/voir` lit des .html
 * hors de l'app et `/sites` (public/sites → symlinks vers le poste de dev)
 * exposait des fiches perso sans session. Ni l'un ni l'autre n'a de contenu
 * dans une image de prod ; ils répondent 404 avant toute autre logique. En dev
 * ils restent disponibles, mais soumis à l'authentification comme le reste.
 */
function legacyPathBlocked(pathname: string): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  return pathname === "/voir" || pathname === "/sites" || pathname.startsWith("/sites/");
}


/** Rate-limit par IP (fenêtre fixe 60 s, in-process — conteneur unique).
 *  RATE_LIMIT_PER_MIN non posée → désactivé (dev). */
const rlBuckets = new Map<string, { n: number; resetAt: number }>();
// Clé de comptage : lib/client-ip (TRUST_PROXY, jamais l'en-tête brut du client).

/** Plafond du rate-limit de bordure (par IP, par processus). FAIL-CLOSED : dans
 *  une vraie mise en ligne (AUTH ou BILLING), un défaut coarse s'applique même
 *  sans variable ; `unlimited`/`off` le lève. C'est un filet anti-flood grossier
 *  — la limite fine PAR UTILISATEUR est en base (guards.rateGate). */
function proxyRateCap(): number | null {
  const raw = process.env.RATE_LIMIT_PER_MIN;
  const guarded = process.env.AUTH_ENABLED === "1" || process.env.BILLING_ENABLED === "1";
  if (raw == null || raw === "") return guarded ? 240 : null;
  if (/^(unlimited|none|off|-1)$/i.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : (guarded ? 240 : null);
}

function rateLimited(req: NextRequest): boolean {
  const cap = proxyRateCap();
  if (cap === null) return false;
  const ip = clientIp(req.headers);
  const now = Date.now();
  const b = rlBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    if (rlBuckets.size > 10_000) rlBuckets.clear(); // borne mémoire
    rlBuckets.set(ip, { n: 1, resetAt: now + 60_000 });
    return false;
  }
  b.n++;
  return b.n > cap;
}

function passThrough(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.delete("x-cortex-user"); // anti-usurpation, même sans auth
  return NextResponse.next({ request: { headers } });
}

async function guarded(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (publicPath(pathname)) return passThrough(req);

  // Import dynamique : la stack NextAuth n'est chargée QUE si l'auth est active.
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  const userId = session?.user?.id;
  // Démo publique (lib/demo-paths) : SEULEMENT pour un visiteur anonyme — un
  // compte connecté voit ses propres données, jamais le tenant « owner ».
  if (demoReadable(pathname, req.method) && !userId) {
    return passThrough(req); // lecture seule du tenant seedé « owner »
  }
  if (!userId) {
    if (pathname.startsWith("/api/")) {
      return apiError(req, "unauthenticated", 401);
    }
    const signin = new URL("/login", req.url);
    signin.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signin);
  }
  const headers = new Headers(req.headers);
  headers.delete("x-cortex-user");
  headers.set("x-cortex-user", userId);
  return NextResponse.next({ request: { headers } });
}

/** Chemins JAMAIS soumis au rate-limit : le healthcheck de la plateforme (le
 *  limiter provoquerait une boucle de redémarrage), le webhook de paiement
 *  (Stripe réessaie et le client ne serait pas crédité), le webhook Railway (l'alerte
 *  d'un incident arrive justement quand le trafic monte ; jeton long, sans autre pouvoir)
 *  et les assets Next. */
const RL_EXEMPT = ["/api/health", "/api/billing/webhook", "/api/ops/railway-webhook", "/_next", "/favicon"];

export default function proxy(req: NextRequest) {
  // Le rate-limit protège aussi une instance SANS auth (démo ouverte) : il est
  // évalué avant la branche d'authentification, mais jamais sur les chemins
  // d'infrastructure ci-dessus.
  const { pathname } = req.nextUrl;
  if (legacyPathBlocked(pathname)) return new NextResponse("Not found", { status: 404 });
  // Ancien domaine (REDIRECT_FROM_HOSTS) → URL publique, avant toute autre logique :
  // une connexion commencée sur l'ancien hôte échouerait (cf. lib/public-url).
  // L'hôte est lu dans des en-têtes que le client peut forger, sans conséquence :
  // la cible est toujours AUTH_URL, il ne peut que se renvoyer lui-même dessus.
  const moved = legacyHostRedirect({
    host: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
    pathname, search: req.nextUrl.search,
  });
  if (moved) return NextResponse.redirect(moved, 308);
  // /api/auth/* est public et lu par NextAuth sans borne : on refuse ici un corps trop grand.
  const authBody = authBodyLimit({ method: req.method, pathname, headers: req.headers });
  if (authBody) return apiError(req, authBody, authBody.status);
  if (!RL_EXEMPT.some((p) => pathname.startsWith(p)) && rateLimited(req)) {
    return apiError(req, "rate_limited", 429);
  }
  if (isToolPath(pathname)) return toolPassThrough(req);
  return AUTH_ON ? guarded(req) : passThrough(req);
}

/** Outil gratuit (public) : sa langue est posée dans le cookie de la requête, que lisent pages et API. */
function toolPassThrough(req: NextRequest): NextResponse {
  const { locale, remember } = toolLocale(req.nextUrl.searchParams.get("lang"), req.headers.get("cookie"));
  const headers = new Headers(req.headers);
  headers.delete("x-cortex-user"); // anti-usurpation : l'outil ne connaît aucun compte
  headers.set("cookie", withLocaleCookie(req.headers.get("cookie"), locale));
  const res = NextResponse.next({ request: { headers } });
  if (remember) res.headers.append("set-cookie", localeCookie(locale));
  return res;
}

export const config = {
  // Tout sauf le statique de Next. ⚠ Ne PAS ré-exclure les extensions image :
  // /uploads/*.png (screenshots d'étudiants = données perso) contournait la
  // garde d'auth via l'ancienne exclusion .png/.jpg du matcher.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
