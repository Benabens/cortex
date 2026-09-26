import { authBodyLimit } from "@/lib/auth-body-limit";
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

const PUBLIC_PREFIXES = ["/api/auth", "/login", "/api/health", "/api/metrics", "/api/billing/webhook", "/_next", "/favicon"];

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

/**
 * DÉMO PUBLIQUE (PUBLIC_DEMO=1, optionnel) : ces pages/API restent lisibles
 * SANS session en GET — un visiteur voit le contenu seedé (tenant « owner »,
 * hydraté par prod-boot) sans pouvoir rien générer ni modifier.
 */
const DEMO_GET_PATHS = new Set([
  "/", "/revision",
  // …et les API que ces pages appellent : sans elles la vitrine s'affiche en erreur.
  "/api/revision", "/api/dashboard", "/api/program",
]);

/** Rate-limit par IP (fenêtre fixe 60 s, in-process — conteneur unique).
 *  RATE_LIMIT_PER_MIN non posée → désactivé (dev). */
const rlBuckets = new Map<string, { n: number; resetAt: number }>();
/**
 * Clé de comptage du rate-limit.
 *
 * Les en-têtes `x-forwarded-for` / `x-real-ip` sont écrits par le CLIENT et
 * seulement complétés par le proxy : leur faire confiance sans savoir combien
 * de proxys nous précèdent rend la limite inutile (il suffit de varier
 * l'en-tête). On n'accepte donc XFF que derrière un proxy déclaré, en prenant
 * le N-ième élément EN PARTANT DE LA FIN, où N = TRUST_PROXY (nombre de hops
 * de confiance ; « 1 » = un proxy, cas Railway). Sans TRUST_PROXY : on ignore
 * totalement les en-têtes et on compte par IP de connexion (`req.ip` quand
 * disponible), quitte à regrouper — mieux vaut une limite grossière qu'une
 * limite contournable d'un `curl -H`.
 */
function clientIp(req: NextRequest): string {
  const hops = Number(process.env.TRUST_PROXY);
  if (Number.isFinite(hops) && hops >= 1) {
    const parts = (req.headers.get("x-forwarded-for") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    // Le proxy le plus proche de nous ajoute en dernier : on remonte de `hops`.
    if (parts.length) return parts[Math.max(0, parts.length - hops)];
  }
  return "direct";
}

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
  const ip = clientIp(req);
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
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return passThrough(req);
  if (process.env.PUBLIC_DEMO === "1" && req.method === "GET" && DEMO_GET_PATHS.has(pathname)) {
    return passThrough(req); // lecture seule du tenant seedé « owner »
  }

  // Import dynamique : la stack NextAuth n'est chargée QUE si l'auth est active.
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
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
 *  (Stripe réessaie et le client ne serait pas crédité) et les assets Next. */
const RL_EXEMPT = ["/api/health", "/api/billing/webhook", "/_next", "/favicon"];

export default function proxy(req: NextRequest) {
  // Le rate-limit protège aussi une instance SANS auth (démo ouverte) : il est
  // évalué avant la branche d'authentification, mais jamais sur les chemins
  // d'infrastructure ci-dessus.
  const { pathname } = req.nextUrl;
  if (legacyPathBlocked(pathname)) return new NextResponse("Not found", { status: 404 });
  // /api/auth/* est public et lu par NextAuth sans borne : on refuse ici un corps trop grand.
  const authBody = authBodyLimit({ method: req.method, pathname, headers: req.headers });
  if (authBody) return NextResponse.json({ error: authBody.error }, { status: authBody.status });
  if (!RL_EXEMPT.some((p) => pathname.startsWith(p)) && rateLimited(req)) {
    return NextResponse.json({ error: "Trop de requêtes — réessaie dans une minute." }, { status: 429 });
  }
  return AUTH_ON ? guarded(req) : passThrough(req);
}

export const config = {
  // Tout sauf le statique de Next. ⚠ Ne PAS ré-exclure les extensions image :
  // /uploads/*.png (screenshots d'étudiants = données perso) contournait la
  // garde d'auth via l'ancienne exclusion .png/.jpg du matcher.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
