/**
 * URL PUBLIQUE de l'app. AUTH_URL en est la source unique : retours de
 * paiement, portail Stripe, redirections OAuth, image de partage. Changer de
 * domaine = changer AUTH_URL (marche à suivre : DEPLOY.md, « Nom de domaine »).
 */
export function publicOrigin(env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  const raw = env.AUTH_URL?.trim();
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

const hostnameOf = (host: string) => host.trim().toLowerCase().replace(/:\d+$/, "");

/** Servis sur n'importe quel hôte : le healthcheck de la plateforme, et le
 *  webhook Stripe tant que l'ancien endpoint existe encore chez Stripe. */
const NEVER_REDIRECTED = ["/api/health", "/api/billing/webhook"];

/**
 * ANCIENS HÔTES. Après un changement de domaine, l'ancien hôte continue de
 * servir l'app, mais une connexion commencée dessus échoue : les cookies d'état
 * OAuth y sont posés alors que Google rappelle l'URL publique. Les hôtes de
 * REDIRECT_FROM_HOSTS (séparés par des virgules) sont renvoyés vers elle, chemin
 * et paramètres conservés. Renvoie l'URL cible, ou null.
 *
 * Liste EXPLICITE, jamais « tout hôte différent de l'URL publique » : derrière
 * un proxy qui réécrirait Host, une règle automatique bouclerait et couperait
 * le site. L'hôte canonique n'est jamais redirigé, même listé par erreur.
 */
export function legacyHostRedirect(
  req: { host: string | null; pathname: string; search: string },
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string | null {
  const origin = publicOrigin(env);
  const legacy = (env.REDIRECT_FROM_HOSTS ?? "").split(",").map(hostnameOf).filter(Boolean);
  if (!origin || !legacy.length || !req.host) return null;
  const host = hostnameOf(req.host);
  if (host === new URL(origin).hostname || !legacy.includes(host)) return null;
  if (NEVER_REDIRECTED.some((p) => req.pathname === p || req.pathname.startsWith(p + "/"))) return null;
  return `${origin}${req.pathname}${req.search}`;
}
