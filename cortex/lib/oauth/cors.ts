/**
 * ORIGINES DE NAVIGATEUR ADMISES par le connecteur MCP — une seule liste pour
 * le CORS des points OAuth et de /mcp, et pour la garde anti « DNS rebinding »
 * de /mcp : l'app elle-même, Claude (claude.ai, claude.com), le poste local
 * (inspecteur MCP) et MCP_ALLOWED_ORIGINS. Jamais « * » : une origine admise
 * est reflétée telle quelle, une autre ne reçoit aucun en-tête CORS (le
 * navigateur bloque la lecture). Les clients serveur à serveur (claude.ai côté
 * serveur, Claude Code) n'envoient pas d'Origin et ne sont pas concernés.
 */

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function allowedOriginHosts(issuer: string): string[] {
  const extra = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)
    .map((o) => { try { return new URL(o).hostname; } catch { return o; } });
  return [new URL(issuer).hostname, "claude.ai", "claude.com", ...LOCAL_HOSTS, ...extra];
}

/** Origine à refléter dans Access-Control-Allow-Origin, ou null. */
export function allowedOrigin(origin: string | null, issuer: string): string | null {
  if (!origin) return null;
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.includes(u.hostname))) {
    // http:// n'est admis que pour le poste local (et l'app en développement).
    if (!(u.protocol === "http:" && u.hostname === new URL(issuer).hostname)) return null;
  }
  return allowedOriginHosts(issuer).includes(u.hostname) ? u.origin : null;
}

/** En-têtes CORS d'une réponse : origine reflétée si admise, toujours `Vary: Origin`. */
export function corsHeaders(req: Request, issuer: string | null, extra: Record<string, string>): Record<string, string> {
  const origin = issuer ? allowedOrigin(req.headers.get("origin"), issuer) : null;
  return { vary: "Origin", ...(origin ? { "access-control-allow-origin": origin, ...extra } : {}) };
}
