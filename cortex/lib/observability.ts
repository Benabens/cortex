/**
 * SUIVI D'ERREURS — OPTIONNEL et sans données personnelles.
 *
 * Sans `SENTRY_DSN`, rien ne change : le SDK n'est même pas chargé (l'app ne
 * paie ni son poids ni son démarrage). Avec la variable, les erreurs du serveur
 * et des workers partent chez Sentry — mais Cortex traite du matériel de cours
 * et des identités d'étudiants : l'événement est NETTOYÉ avant envoi (aucun
 * e-mail, aucun identifiant, aucun en-tête, aucun cookie, aucun corps de
 * requête, aucun prompt ni énoncé, URL sans paramètres). Les journaux JSON de
 * lib/metrics restent la source primaire ; Sentry n'est qu'une alerte.
 *
 * Le paquet est chargé dynamiquement : s'il est absent, l'application démarre
 * quand même (dégradation silencieuse). C'est `@sentry/node` et non le SDK Next :
 * on ne rapporte QUE le serveur et les workers — rien depuis le navigateur, donc
 * aucune session d'étudiant instrumentée — pour 44 Mo au lieu de 100 dans l'image.
 */
import { log } from "@/lib/metrics";

type SentryLike = {
  init: (options: Record<string, unknown>) => void;
  captureException?: (e: unknown, hint?: Record<string, unknown>) => void;
};
export type InitResult = "disabled" | "enabled" | "unavailable";

let _sentry: SentryLike | null = null;

/** Événement Sentry, réduit à ce que nous manipulons. */
type MinimalEvent = {
  user?: unknown;
  request?: { url?: string; headers?: unknown; cookies?: unknown; data?: unknown; query_string?: unknown };
  extra?: unknown;
  contexts?: Record<string, unknown>;
  breadcrumbs?: unknown[];
  [k: string]: unknown;
};

/**
 * Retire tout ce qui peut porter une identité ou du contenu de cours. Ne garde
 * que l'exception, la pile, le service et l'URL sans paramètres.
 */
export function scrubEvent(event: MinimalEvent): MinimalEvent {
  const e = { ...event };
  delete e.user;
  delete e.extra;
  if (e.contexts) {
    const { trace, runtime, os } = e.contexts as Record<string, unknown>;
    e.contexts = { ...(trace ? { trace } : {}), ...(runtime ? { runtime } : {}), ...(os ? { os } : {}) };
  }
  if (e.request) {
    const url = typeof e.request.url === "string" ? e.request.url.split("?")[0] : undefined;
    e.request = url ? { url } : {};
  }
  // Les miettes portent des URL avec `?course=` et des libellés d'action : inutiles ici.
  if (e.breadcrumbs) e.breadcrumbs = [];
  return e;
}

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
      environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || "development",
      sendDefaultPii: false,
      tracesSampleRate: tracesSampleRate(),
      initialScope: { tags: { service: opts.service ?? "web" } },
      beforeSend: (event: MinimalEvent) => scrubEvent(event),
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

/** (tests) oublie le SDK chargé. */
export function resetErrorTrackingForTests(): void { _sentry = null; }
