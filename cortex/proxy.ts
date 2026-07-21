import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * PROXY Next 16 (ex-middleware) — garde d'authentification OPT-IN (Phase B4).
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

const PUBLIC_PREFIXES = ["/api/auth", "/api/health", "/api/metrics", "/api/billing/webhook", "/_next", "/favicon", "/sites"];

/**
 * DÉMO PUBLIQUE (PUBLIC_DEMO=1, optionnel) : ces pages/API restent lisibles
 * SANS session en GET — un visiteur voit le contenu seedé (tenant « owner »,
 * hydraté par prod-boot) sans pouvoir rien générer ni modifier.
 */
const DEMO_GET_PATHS = new Set(["/", "/revision", "/projet", "/api/revision", "/api/projet"]);

/** Rate-limit par IP (fenêtre fixe 60 s, in-process — conteneur unique).
 *  RATE_LIMIT_PER_MIN non posée → désactivé (dev). */
const rlBuckets = new Map<string, { n: number; resetAt: number }>();
function rateLimited(req: NextRequest): boolean {
  const cap = Number(process.env.RATE_LIMIT_PER_MIN);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
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
  if (rateLimited(req)) {
    return NextResponse.json({ error: "Trop de requêtes — réessaie dans une minute." }, { status: 429 });
  }
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
    const signin = new URL("/api/auth/signin", req.url);
    signin.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signin);
  }
  const headers = new Headers(req.headers);
  headers.delete("x-cortex-user");
  headers.set("x-cortex-user", userId);
  return NextResponse.next({ request: { headers } });
}

export default function proxy(req: NextRequest) {
  return AUTH_ON ? guarded(req) : passThrough(req);
}

export const config = {
  // Tout sauf le statique de Next. ⚠ Ne PAS ré-exclure les extensions image :
  // /uploads/*.png (screenshots d'étudiants = données perso) contournait la
  // garde d'auth via l'ancienne exclusion .png/.jpg du matcher.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
