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

const PUBLIC_PREFIXES = ["/api/auth", "/_next", "/favicon", "/sites"];

function passThrough(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.delete("x-cortex-user"); // anti-usurpation, même sans auth
  return NextResponse.next({ request: { headers } });
}

async function guarded(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return passThrough(req);

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
  // Tout sauf les assets statiques (ils n'ont pas de contexte utilisateur).
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|ico|css|js|map)$).*)"],
};
