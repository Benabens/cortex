/**
 * SONDEUR DE JOB PARTAGÉ — un seul par (cours, job), quel que soit le nombre de
 * composants qui l'affichent.
 *
 * Avant, chaque composant montait son propre sondage toutes les 1,8 s avec un
 * `fetch` brut : six points de montage dans l'app, donc plusieurs appels par
 * tour pour un même job, rien en pause quand l'onglet passait en arrière-plan,
 * et ~33 requêtes/minute par sondeur. La limite de bordure étant de 240/min,
 * quelques onglets suffisaient à renvoyer des 429 sur toute l'app (audit de
 * pré-lancement). Ici : un abonnement partagé, une requête par tour, en pause
 * quand l'onglet est caché, arrêt dès que le job est dans un état final, et
 * l'abonné tardif reçoit le dernier état connu sans appel réseau.
 *
 * Sans dépendance à React : testable tel quel (timers et visibilité injectables).
 */
import { JOB_ACTIVE, type Job } from "./job-status";

export const JOB_POLL_MS = 1800;
/** Erreur réseau transitoire : on espace, on n'abandonne pas. */
export const JOB_RETRY_MS = 4000;

export type JobWatchDeps = {
  fetchJob: (jobId: number, course: string) => Promise<Job | null>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  isHidden: () => boolean;
  /** S'abonne au retour au premier plan ; renvoie le désabonnement. */
  onVisible: (cb: () => void) => () => void;
};

const browserDeps: JobWatchDeps = {
  async fetchJob(jobId, course) {
    const res = await fetch(`/api/jobs/${jobId}?course=${encodeURIComponent(course)}`);
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const d = (await res.json()) as { job?: Job } & Job;
    return (d.job ?? d) as Job;
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  onVisible: (cb) => {
    if (typeof document === "undefined") return () => {};
    const handler = () => { if (document.visibilityState === "visible") cb(); };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
};

let deps: JobWatchDeps = browserDeps;
/** (tests) remplace timers, réseau et visibilité. */
export function configureJobWatch(d: Partial<JobWatchDeps>): void {
  deps = { ...browserDeps, ...d };
}

type Watch = {
  listeners: Set<(job: Job) => void>;
  last: Job | null;
  timer: unknown | null;
  offVisible: (() => void) | null;
  polling: boolean;
};
const watches = new Map<string, Watch>();

/** (tests) oublie tous les sondages en cours. */
export function resetJobWatch(): void {
  for (const w of watches.values()) {
    if (w.timer !== null) deps.clearTimer(w.timer);
    w.offVisible?.();
  }
  watches.clear();
  deps = browserDeps;
}

function schedule(key: string, w: Watch, ms: number): void {
  if (!w.listeners.size) return;
  w.timer = deps.setTimer(() => { w.timer = null; void poll(key, w); }, ms);
}

async function poll(key: string, w: Watch): Promise<void> {
  if (!w.listeners.size || w.polling) return;
  const [course, idStr] = key.split("|");
  // Onglet caché : on ne consomme ni requête ni quota — le retour au premier plan relance.
  if (deps.isHidden()) return;
  w.polling = true;
  try {
    const job = await deps.fetchJob(Number(idStr), course);
    if (job) {
      w.last = job;
      for (const fn of [...w.listeners]) fn(job);
      if (JOB_ACTIVE.includes(job.status)) schedule(key, w, JOB_POLL_MS);
      return;
    }
    schedule(key, w, JOB_RETRY_MS);
  } catch {
    schedule(key, w, JOB_RETRY_MS);
  } finally {
    w.polling = false;
  }
}

/**
 * S'abonne à l'état d'un job. Renvoie le désabonnement ; le sondage s'arrête
 * quand le dernier abonné part.
 */
export function watchJob(jobId: number, course: string, listener: (job: Job) => void): () => void {
  const key = `${course}|${jobId}`;
  let w = watches.get(key);
  const isFirst = !w;
  if (!w) {
    w = { listeners: new Set(), last: null, timer: null, offVisible: null, polling: false };
    watches.set(key, w);
    w.offVisible = deps.onVisible(() => { if (w!.timer === null) void poll(key, w!); });
  }
  w.listeners.add(listener);
  // Abonné tardif : servi depuis le dernier état connu, sans appel réseau.
  if (w.last) listener(w.last);
  if (isFirst) void poll(key, w);
  else if (w.timer === null && !w.polling && (!w.last || JOB_ACTIVE.includes(w.last.status))) void poll(key, w);

  return () => {
    const cur = watches.get(key);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size) return;
    if (cur.timer !== null) { deps.clearTimer(cur.timer); cur.timer = null; }
    cur.offVisible?.();
    watches.delete(key);
  };
}
