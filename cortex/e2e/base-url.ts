/**
 * Cible des parcours : le serveur local que Playwright démarre (défaut), ou une
 * instance déjà en ligne — la preview d'une PR (E2E_BASE_URL, workflow preview).
 * Partagé par playwright.config.ts et les specs qui construisent des URL absolues.
 */
export const localPort = Number(process.env.E2E_PORT ?? 3210);
export const remoteBaseURL = process.env.E2E_BASE_URL?.replace(/\/+$/, "") || undefined;
export const baseURL = remoteBaseURL ?? `http://localhost:${localPort}`;

/** La vraie prod : cible du smoke post-déploiement et du vrai Google. */
const PROD_URL = "https://app.cortexexam.com";
export const smokeBaseURL = process.env.E2E_SMOKE_BASE_URL ?? PROD_URL;
export const googleBaseURL = process.env.E2E_GOOGLE_BASE_URL ?? PROD_URL;
