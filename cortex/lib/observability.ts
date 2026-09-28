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
  message?: unknown;
  exception?: { values?: Array<{ value?: unknown; [k: string]: unknown }> };
  request?: { url?: string; headers?: unknown; cookies?: unknown; data?: unknown; query_string?: unknown };
  extra?: unknown;
  contexts?: Record<string, unknown>;
  breadcrumbs?: unknown[];
  [k: string]: unknown;
};

/** Longueur retenue d'un message : au-delà, ce n'est plus un diagnostic mais du contenu. */
const MESSAGE_MAX = 200;

/**
 * Rend un message d'erreur publiable. Indispensable : `lib/exam-latex.ts` place
 * jusqu'à 800 caractères de journal tectonic dans le message d'exception, et ce
 * journal cite le chemin du corpus (donc l'identifiant de l'étudiant) et le
 * texte des énoncés. On ne garde que la tête du message — la nature de la panne
 * — en retirant chemins et contenus entre accolades.
 */
export function redactMessage(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  // « | » est le séparateur des lignes de journal : tout ce qui suit la première
  // ligne est du détail de compilation, c'est-à-dire du contenu de cours.
  const cut = t.indexOf(" | ");
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/\{[^{}]*\}/g, "{…}"); // \subq{énoncé}, \input{fichier}
  t = t.replace(/(?:[\w.~@%+-]*\/)+[\w.~@%+-]*/g, "<chemin>"); // data/u/<slug>/…, URL
  return t.length > MESSAGE_MAX ? t.slice(0, MESSAGE_MAX) + "…" : t;
}

/**
 * Retire tout ce qui peut porter une identité ou du contenu de cours. Ne garde
 * que la nature de l'exception, la pile, le service et l'URL sans paramètres.
 */
export function scrubEvent(event: MinimalEvent): MinimalEvent {
  const e = { ...event };
  delete e.user;
  delete e.extra;
  if (typeof e.message === "string") e.message = redactMessage(e.message);
  else if (e.message && typeof e.message === "object") {
    const m = e.message as Record<string, unknown>;
    e.message = {
      ...m,
      ...(typeof m.message === "string" ? { message: redactMessage(m.message) } : {}),
      ...(typeof m.formatted === "string" ? { formatted: redactMessage(m.formatted) } : {}),
      params: undefined,
    };
  }
  if (e.exception?.values) {
    e.exception = {
      ...e.exception,
      values: e.exception.values.map((v) => (typeof v.value === "string" ? { ...v, value: redactMessage(v.value) } : v)),
    };
  }
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

/**
 * Un span de performance porte une description (souvent une requête SQL ou une
 * URL complète) et des attributs libres : on ne garde que la nature de
 * l'opération. Sans ça, `SENTRY_TRACES_SAMPLE_RATE` contournerait le nettoyage.
 */
export function scrubSpan(span: Record<string, unknown>): Record<string, unknown> {
  const s = { ...span };
  delete s.data;
  delete s.attributes;
  if (typeof s.description === "string") s.description = redactMessage(s.description);
  return s;
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

/** (tests) oublie le SDK chargé. */
export function resetErrorTrackingForTests(): void { _sentry = null; }
