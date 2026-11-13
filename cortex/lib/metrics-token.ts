import { timingSafeEqual } from "node:crypto";

/** Égalité en temps constant (les longueurs différentes sont refusées sans fuite d'information utile). */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Vrai si la requête porte `Authorization: Bearer <METRICS_TOKEN>`. Jamais en
 * query string (il finirait dans les logs, l'historique, le Referer). Sans
 * METRICS_TOKEN configuré : toujours faux.
 */
export function hasMetricsToken(req: Request): boolean {
  const expected = process.env.METRICS_TOKEN;
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return !!expected && tokenMatches(m ? m[1].trim() : null, expected);
}
