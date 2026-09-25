import { currentUser } from "@/db/context";
import { log } from "@/lib/metrics";

/**
 * JOURNAL DES ROUTES « BOUCLE ».
 *
 * `/api/drill`, `/api/check-solution`, `/api/weaknesses/*` sont les seules
 * routes qui déclenchent un appel LLM SANS passer par un job — donc les seules
 * appelables en rafale. L'audit demande de les voir venir : user + IP + durée.
 * best-effort, jamais bloquant.
 */

/** IP client — même logique que proxy.ts (XFF derrière TRUST_PROXY, sinon direct). */
function reqIp(req: Request): string {
  const hops = Number(process.env.TRUST_PROXY);
  if (Number.isFinite(hops) && hops >= 1) {
    const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[Math.max(0, parts.length - hops)];
  }
  return req.headers.get("x-real-ip") ?? "direct";
}

/** Trace un accès à une route « boucle ». `startedAt` = Date.now() en entrée. */
export function logLoopRoute(req: Request, route: string, startedAt: number, extra?: Record<string, unknown>): void {
  try {
    log("info", "route.loop", {
      route,
      user: currentUser(),
      ip: reqIp(req),
      ms: Date.now() - startedAt,
      ...extra,
    });
  } catch {
    /* le journal ne casse jamais la requête */
  }
}
