import { isGuardedDeployment } from "@/lib/boot-guards";
import { publicOrigin } from "@/lib/public-url";

/**
 * RÉGLAGES DU SERVEUR D'AUTORISATION MCP (Cortex est son propre serveur OAuth 2.1
 * pour le connecteur MCP — docs/MCP.md).
 *
 * OPT-IN : rien n'est servi sans MCP_ENABLED=1 (invariant n° 6 : une fonctionnalité
 * s'active par configuration). En déploiement gardé, l'émetteur DOIT venir
 * d'AUTH_URL : déduit de l'en-tête Host, il serait falsifiable (métadonnées et
 * audience des jetons choisies par le client). Hors déploiement gardé (poste de
 * dev, inspecteur MCP), l'origine de la requête sert de repli.
 */

export const SCOPE_READ = "cortex.read";
export const SCOPE_GENERATE = "cortex.generate";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_GENERATE] as const;

/** Durées de vie, en secondes. Jeton d'accès court ; refresh tournant à chaque usage. */
export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 86400;
export const AUTH_CODE_TTL_S = 60;
/** Ticket de consentement : le temps de lire l'écran et de cliquer. */
export const CONSENT_TTL_S = 600;

export function mcpEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.MCP_ENABLED === "1";
}

/**
 * Émetteur (issuer) = origine publique de l'app, sans chemin ni barre finale.
 * null = MCP indisponible sur cette instance (désactivé, ou gardé sans AUTH_URL).
 */
export function issuerFor(req: Request, env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  if (!mcpEnabled(env)) return null;
  const pub = publicOrigin(env);
  if (pub) return pub;
  if (isGuardedDeployment(env)) return null;
  try { return new URL(req.url).origin; } catch { return null; }
}

/** Identifiant canonique de la ressource protégée (RFC 8707 / RFC 9728) : l'URL du point MCP. */
export function resourceFor(issuer: string): string {
  return `${issuer}/mcp`;
}

/**
 * Forme canonique d'un indicateur de ressource pour comparaison : schéma et hôte
 * en minuscules, port par défaut retiré, sans fragment ni barre finale. null si
 * ce n'est pas une URL absolue http(s).
 */
export function canonicalResource(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hash || u.username || u.password) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}
