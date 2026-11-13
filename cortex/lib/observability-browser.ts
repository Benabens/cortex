/**
 * SUIVI D'ERREURS DANS LE NAVIGATEUR — démarré par components/ErrorTracking
 * (layout racine) avec la configuration servie au runtime par
 * GET /api/monitoring : sans SENTRY_DSN, la réponse est vide et
 * `@sentry/browser` n'est jamais téléchargé (morceau chargé à la demande).
 *
 * Ce qui part : type, message nettoyé et pile de l'erreur, URL sans paramètres,
 * navigateur et système. Ce qui ne part jamais : miettes (clics, console,
 * navigation — elles citent le texte des énoncés et les URL `?course=`),
 * sessions (suivi des visites), replay, traces, adresse IP, en-têtes. Les
 * envois passent par le tunnel de l'app (même origine) : la CSP garde
 * connect-src 'self'.
 */
import { MONITORING_TUNNEL, scrubEvent, type ClientErrorTrackingConfig, type MinimalEvent } from "@/lib/observability-scrub";

type BrowserSentryLike = {
  init: (options: Record<string, unknown>) => void;
  captureException?: (e: unknown, hint?: Record<string, unknown>) => void;
};
type InitResult = "disabled" | "enabled" | "unavailable";

/** Intégrations par défaut qui collectent plus que l'erreur elle-même. */
const DROPPED_INTEGRATIONS = new Set(["Breadcrumbs", "BrowserSession"]);

let _sentry: BrowserSentryLike | null = null;

/** Configuration servie par l'app ; null (suivi éteint) sur 204, réponse inattendue ou réseau coupé. */
export async function loadClientErrorTrackingConfig(fetchImpl: typeof fetch = fetch): Promise<ClientErrorTrackingConfig | null> {
  try {
    const r = await fetchImpl(MONITORING_TUNNEL, { cache: "no-store", credentials: "omit" });
    if (r.status !== 200) return null;
    const c = (await r.json()) as Partial<ClientErrorTrackingConfig>;
    if (typeof c.dsn !== "string" || typeof c.environment !== "string" || c.tunnel !== MONITORING_TUNNEL) return null;
    return { dsn: c.dsn, environment: c.environment, ...(typeof c.release === "string" ? { release: c.release } : {}), tunnel: c.tunnel };
  } catch {
    return null;
  }
}

export async function startClientErrorTracking(
  config: ClientErrorTrackingConfig | null,
  load: () => Promise<BrowserSentryLike> = () => import("@sentry/browser") as unknown as Promise<BrowserSentryLike>,
): Promise<InitResult> {
  if (!config?.dsn) return "disabled";
  if (_sentry) return "enabled";
  try {
    const sentry = await load();
    sentry.init({
      dsn: config.dsn,
      environment: config.environment,
      ...(config.release ? { release: config.release } : {}),
      tunnel: config.tunnel,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      integrations: (defaults: Array<{ name: string }>) => defaults.filter((i) => !DROPPED_INTEGRATIONS.has(i.name)),
      beforeBreadcrumb: () => null,
      beforeSend: (event: MinimalEvent) => scrubEvent(event),
      initialScope: { tags: { service: "browser" } },
    });
    _sentry = sentry;
    return "enabled";
  } catch {
    return "unavailable"; // bloqueur de publicité, réseau coupé : l'app ne doit rien en sentir
  }
}

/**
 * Erreur rattrapée par une frontière d'erreur React (app/error.tsx,
 * app/global-error.tsx) : React ne la propage pas jusqu'à window.onerror, le
 * SDK ne la verrait donc jamais seul. No-op si le suivi n'est pas démarré.
 */
export function captureClientError(e: unknown): void {
  try {
    _sentry?.captureException?.(e, { tags: { kind: "boundary" } });
  } catch {
    /* le suivi d'erreurs ne doit jamais casser la page d'erreur */
  }
}
