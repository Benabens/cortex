/**
 * DÉMO PUBLIQUE (PUBLIC_DEMO=1, optionnel) : ces pages/API restent lisibles
 * SANS session en GET — un visiteur ANONYME voit le contenu seedé (tenant
 * « owner », hydraté par prod-boot) sans pouvoir rien générer ni modifier.
 * Un compte connecté n'est jamais concerné : il voit ses propres données.
 */
export const DEMO_GET_PATHS = new Set([
  "/", "/revision",
  // …et les API que ces pages appellent : sans elles la vitrine s'affiche en erreur.
  "/api/revision", "/api/dashboard", "/api/program",
]);

export function demoReadable(pathname: string, method: string, env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.PUBLIC_DEMO === "1" && method.toUpperCase() === "GET" && DEMO_GET_PATHS.has(pathname);
}
