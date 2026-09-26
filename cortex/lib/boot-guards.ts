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
