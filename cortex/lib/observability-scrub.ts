/**
 * NETTOYAGE DES ÉVÉNEMENTS SENTRY — fonctions pures, partagées par le serveur
 * (lib/observability) et le navigateur (lib/observability-browser) : aucune
 * dépendance serveur ici, ce module part dans le bundle client.
 */
import { isPrEnvironment, railwayEnvironmentName } from "@/lib/railway-env";

/** Événement Sentry, réduit à ce que nous manipulons. */
export type MinimalEvent = {
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
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<e-mail>"); // identité d'un compte, avant les chemins (« @ » y est permis)
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

/**
 * Environnement Sentry. Une preview de PR l'emporte sur SENTRY_ENVIRONMENT :
 * Railway copie les variables de la prod dans l'environnement de la PR, et ses
 * erreurs ne doivent pas déclencher les alertes de la production.
 */
export function sentryEnvironment(env: Partial<NodeJS.ProcessEnv>): string {
  const railway = railwayEnvironmentName(env);
  if (env.CORTEX_PREVIEW === "1" || isPrEnvironment(railway)) return "preview";
  return env.SENTRY_ENVIRONMENT?.trim() || (railway === "production" ? "production" : env.NODE_ENV || "development");
}

/** Release = commit déployé (posé par Railway), pour savoir quel déploiement a introduit une erreur. */
export function sentryRelease(env: Partial<NodeJS.ProcessEnv>): string | undefined {
  return env.SENTRY_RELEASE?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined;
}

/** Ce que le navigateur reçoit pour démarrer son suivi d'erreurs (rien sans SENTRY_DSN). */
export type ClientErrorTrackingConfig = { dsn: string; environment: string; release?: string; tunnel: string };

/** Chemin du tunnel (app/api/monitoring) : le navigateur n'écrit qu'à sa propre origine (CSP connect-src 'self'). */
export const MONITORING_TUNNEL = "/api/monitoring";
