/**
 * ENVIRONNEMENT RAILWAY — module pur (serveur, navigateur, garde de démarrage).
 * Le nom vient des variables que Railway pose lui-même ; les environnements
 * éphémères de PR se nomment « <projet>-pr-<n> » (cortex-pr-66).
 */

/** Nom de l'environnement Railway ; vide hors Railway. */
export function railwayEnvironmentName(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || "").trim();
}

/** Environnement éphémère d'une PR (jamais la production). */
export function isPrEnvironment(name: string): boolean {
  return /(?:^|-)pr-\d+$/i.test(name);
}
