/**
 * SUIVI D'ERREURS — OPTIONNEL et sans données personnelles.
 *
 * Sans `SENTRY_DSN`, rien ne change : aucun SDK n'est chargé, ni sur le serveur
 * ni dans le navigateur. Avec la variable, les erreurs du serveur, des workers
 * et du navigateur partent chez Sentry — mais Cortex traite du matériel de cours
 * et des identités d'étudiants : l'événement est NETTOYÉ avant envoi (aucun
 * e-mail, aucun identifiant, aucun en-tête, aucun cookie, aucun corps de
 * requête, aucun prompt ni énoncé, URL sans paramètres ; cf.
 * lib/observability-scrub). Chaque événement porte le commit déployé (release)
 * et l'environnement (production / preview). Les journaux JSON de lib/metrics
 * restent la source primaire ; Sentry n'est qu'une alerte.
 *
 * Les paquets sont chargés dynamiquement : s'ils sont absents, l'application
 * démarre quand même (dégradation silencieuse). `@sentry/node` sur le serveur et
 * `@sentry/browser` dans le navigateur, plutôt que `@sentry/nextjs` : ce dernier
 * tire webpack et le binaire sentry-cli (~100 Mo dans l'image) pour l'envoi des
 * source maps, que nous n'utilisons pas. Les erreurs de rendu et de route non
 * gérées arrivent par le crochet `onRequestError` de Next (instrumentation.ts).
 */
import { log } from "@/lib/metrics";
import {
  MONITORING_TUNNEL, scrubEvent, scrubSpan, sentryEnvironment, sentryRelease,
  type ClientErrorTrackingConfig, type MinimalEvent,
} from "@/lib/observability-scrub";

export { MONITORING_TUNNEL, redactMessage, scrubEvent, scrubSpan, type ClientErrorTrackingConfig } from "@/lib/observability-scrub";

type SentryLike = {
  init: (options: Record<string, unknown>) => void;
  captureException?: (e: unknown, hint?: Record<string, unknown>) => void;
};
export type InitResult = "disabled" | "enabled" | "unavailable";

let _sentry: SentryLike | null = null;

function tracesSampleRate(): number {
  const n = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

/**
 * Démarre le suivi d'erreurs si (et seulement si) `SENTRY_DSN` est posé.
 * `service` distingue le serveur du worker dans les alertes.
 */
export async function initErrorTracking(
  opts: { load?: () => Promise<SentryLike>; service?: string } = {},
): Promise<InitResult> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return "disabled";
  const load = opts.load ?? (() => import("@sentry/node") as unknown as Promise<SentryLike>);
  try {
    const sentry = await load();
    sentry.init({
      dsn,
      environment: sentryEnvironment(process.env),
      release: sentryRelease(process.env),
      sendDefaultPii: false,
      tracesSampleRate: tracesSampleRate(),
      initialScope: { tags: { service: opts.service ?? "web" } },
      beforeSend: (event: MinimalEvent) => scrubEvent(event),
      // Une transaction est un événement : même nettoyage. Un span n'en est pas un.
      beforeSendTransaction: (event: MinimalEvent) => scrubEvent(event),
      beforeSendSpan: (span: Record<string, unknown>) => scrubSpan(span),
    });
    _sentry = sentry;
    log("info", "observability.sentry_enabled", { service: opts.service ?? "web" });
    return "enabled";
  } catch (e) {
    log("warn", "observability.sentry_unavailable", { message: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    return "unavailable";
  }
}

/**
 * Signale une erreur DÉJÀ gérée (le journal reste la source primaire). No-op si
 * le suivi n'est pas actif. Les étiquettes passées ici doivent rester techniques
 * — jamais d'e-mail, de contenu de cours ni d'identifiant d'utilisateur.
 */
export function captureError(e: unknown, tags: Record<string, string> = {}): void {
  if (!_sentry?.captureException) return;
  try {
    _sentry.captureException(e, { tags });
  } catch {
    /* le suivi d'erreurs ne doit jamais casser le chemin d'exécution */
  }
}

/** Contexte que Next passe à `onRequestError` (instrumentation.ts). */
export type RequestErrorContext = {
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "middleware" | "proxy";
};

/**
 * Erreur NON gérée d'un rendu ou d'une route, remontée par Next. On garde le
 * MODÈLE de route (« /api/drill », « /cours/[slug] ») et jamais la requête :
 * son chemin réel, ses paramètres et ses en-têtes portent l'identité et le cours.
 */
export function captureRequestError(e: unknown, context: RequestErrorContext): void {
  captureError(e, { kind: "request", route: context.routePath, routeType: context.routeType });
}

/**
 * Servi au RUNTIME par GET /api/monitoring, que le navigateur interroge au
 * chargement : le DSN n'est jamais figé dans le build (pas de NEXT_PUBLIC_), ni
 * dans les pages prérendues au build, qui n'ont pas les variables de la prod.
 */
export function clientErrorTrackingConfig(env: Partial<NodeJS.ProcessEnv> = process.env): ClientErrorTrackingConfig | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  const release = sentryRelease(env);
  return { dsn, environment: sentryEnvironment(env), ...(release ? { release } : {}), tunnel: MONITORING_TUNNEL };
}

/** (tests) oublie le SDK chargé. */
export function resetErrorTrackingForTests(): void { _sentry = null; }
