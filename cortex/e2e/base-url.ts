/**
 * Cible des parcours : le serveur local que Playwright démarre (défaut), ou une
 * instance déjà en ligne — la preview d'une PR (E2E_BASE_URL, workflow preview).
 * Partagé par playwright.config.ts et les specs qui construisent des URL absolues.
 */
export const localPort = Number(process.env.E2E_PORT ?? 3210);
export const remoteBaseURL = process.env.E2E_BASE_URL?.replace(/\/+$/, "") || undefined;
export const baseURL = remoteBaseURL ?? `http://localhost:${localPort}`;
