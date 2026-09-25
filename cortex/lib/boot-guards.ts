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
