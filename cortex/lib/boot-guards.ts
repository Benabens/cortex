/**
 * GARDES DE DÉMARRAGE (appelées par scripts/prod-boot.ts avant `next start`).
 *
 * Sans AUTH_ENABLED=1, le proxy laisse tout passer et chaque visiteur est
 * « owner » : c'est le mode dev mono-user. Oublier la variable sur une vraie
 * mise en ligne ouvrirait les données de l'instance à tout Internet, et une
 * instance qui encaisse (BILLING_ENABLED=1) sans identité ne peut créditer
 * personne. On refuse donc de démarrer plutôt que de le découvrir en prod.
 */
export function assertAuthRequired(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  const authOn = env.AUTH_ENABLED === "1";
  if (authOn) return;
  const reasons: string[] = [];
  if (env.NODE_ENV === "production") reasons.push("NODE_ENV=production");
  if (env.BILLING_ENABLED === "1") reasons.push("BILLING_ENABLED=1");
  if (!reasons.length) return;
  throw new Error(
    `Configuration dangereuse : ${reasons.join(" et ")} sans AUTH_ENABLED=1. ` +
    "Sans authentification, chaque visiteur serait « owner » et verrait toutes les données. " +
    "Pose AUTH_ENABLED=1 (avec AUTH_SECRET, DB_DRIVER=postgres) — ou retire NODE_ENV/BILLING_ENABLED " +
    "pour une instance de développement locale."
  );
}

/**
 * Variante pour le SERVEUR Next (instrumentation.register) : `next start` force
 * NODE_ENV=production en interne, même sur un poste de dev ou dans le smoke
 * test de la CI — ce signal ne veut donc rien dire là. On refuse de servir si
 * l'instance ENCAISSE (BILLING_ENABLED=1) ou si elle tourne manifestement chez
 * l'hébergeur (variables posées par Railway, ou CORTEX_HOSTED=1) sans
 * AUTH_ENABLED=1. prod-boot (entrypoint Docker) garde en plus le critère
 * NODE_ENV, posé explicitement par l'image.
 */
export function assertAuthRequiredHosted(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  if (env.AUTH_ENABLED === "1") return;
  const reasons: string[] = [];
  if (env.BILLING_ENABLED === "1") reasons.push("BILLING_ENABLED=1");
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.CORTEX_HOSTED === "1") reasons.push("instance hébergée (Railway / CORTEX_HOSTED=1)");
  if (!reasons.length) return;
  throw new Error(
    `Configuration dangereuse : ${reasons.join(" et ")} sans AUTH_ENABLED=1. ` +
    "Sans authentification, chaque visiteur serait « owner » et verrait toutes les données. " +
    "Pose AUTH_ENABLED=1 (avec AUTH_SECRET, DB_DRIVER=postgres)."
  );
}

/**
 * DÉPLOIEMENT GARDÉ = instance qui sert d'autres gens que son propriétaire ou
 * qui encaisse : AUTH_ENABLED=1, BILLING_ENABLED=1, hébergeur (Railway) ou
 * CORTEX_HOSTED=1. Les gardes « fail-closed » ne s'appliquent que là.
 */
export function isGuardedDeployment(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.AUTH_ENABLED === "1" || env.BILLING_ENABLED === "1" ||
    Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID) || env.CORTEX_HOSTED === "1";
}

/**
 * Le provider `claude-code` (CLI local, défaut quand LLM_PROVIDER est absent)
 * facture 0 (session personnelle du propriétaire) et donne au modèle un outil
 * Read sur le dépôt : sur une instance multi-utilisateurs, hébergée ou
 * facturée, chaque visiteur consommerait l'abonnement du propriétaire et
 * pourrait faire lire n'importe quel fichier. Refus au boot, sauf
 * CORTEX_OWNER_ONLY=1 (instance que son propriétaire est seul à utiliser).
 */
export function assertLlmProviderAllowed(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  const provider = env.LLM_PROVIDER || "claude-code";
  if (provider !== "claude-code") return;
  if (!isGuardedDeployment(env) || env.CORTEX_OWNER_ONLY === "1") return;
  throw new Error(
    "Configuration dangereuse : LLM_PROVIDER=claude-code (CLI local, coût 0, outil Read sur le dépôt) sur une instance " +
    "multi-utilisateurs, hébergée ou facturée. Pose LLM_PROVIDER=anthropic (ou openai-compatible) avec LLM_API_KEY — " +
    "ou CORTEX_OWNER_ONLY=1 si tu es vraiment le seul utilisateur de cette instance."
  );
}
