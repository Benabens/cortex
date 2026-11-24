/**
 * SUIVI GLOBAL DES GÉNÉRATIONS — ce que la pastille et la notification de fin lisent. Avant, un
 * examen lancé puis quitté disparaissait de l'interface : rien ne disait qu'il tournait encore,
 * ni qu'il était prêt (audit generation-ux du 24/11/2026).
 *
 * Un seul sondeur pour l'app : GET /api/jobs/running (tous les cours du compte), toutes les 6 s
 * tant qu'une génération tourne, toutes les 45 s sinon, relancé tout de suite au retour sur
 * l'onglet et quand une page lance un job (`notifyJobStarted`). Onglet caché : toutes les 20 s
 * tant qu'une génération tourne (sa fin se voit dans le titre de l'onglet), rien sinon. Un job
 * qui quitte la liste est relu une fois : terminé ou en échec, il devient une notification, sauf
 * si la page qui le suivait a montré sa fin (`showJob`). Sans dépendance à React
 * (useSyncExternalStore côté composants) ; réseau, timers et visibilité injectables pour les tests.
 */
import type { Job } from "./job-status";

/** Une génération en cours vue par la pastille : le job tel que l'interface le lit, et son cours. */
export type RunningJob = Pick<Job, "id" | "type" | "status" | "progress" | "currentStep" | "stepInfo" | "eta" | "etaRange" | "etaLate"> & {
  course: string;
  courseLabel: string;
  createdAt: string;
};

export type GenerationToast = {
  key: string; id: number; course: string; courseLabel: string; type: string;
  status: "done" | "failed"; resultPath: string | null;
  /** Échec : la cause, dans la langue du lecteur (GET /api/jobs/[id]). */
  error: string | null;
};

export type TrackerState = { jobs: RunningJob[]; toasts: GenerationToast[]; shown: ReadonlySet<string> };

export type TrackerDeps = {
  fetchRunning: () => Promise<RunningJob[]>;
  fetchFinal: (id: number, course: string) => Promise<{ status: string; resultPath: string | null; error?: string | null } | null>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  isHidden: () => boolean;
  onVisible: (cb: () => void) => () => void;
  now: () => number;
};

export const ACTIVE_POLL_MS = 6000;
export const IDLE_POLL_MS = 45_000;
export const HIDDEN_POLL_MS = 20_000;
const TOAST_LIMIT = 3;
/** Une page a montré la fin du job : pas de notification en double dans ce délai. */
const RECENTLY_SHOWN_MS = 20_000;
const unshownAt = new Map<string, number>();
/** Jobs qu'une page a vus finir avant le tracker (annulés depuis le suivi) : un sondage parti avant ne les remet pas. */
const ENDED_MS = 30_000;
const endedAt = new Map<string, number>();

export const jobKey = (course: string, id: number) => `${course}:${id}`;

const browserDeps: TrackerDeps = {
  async fetchRunning() {
    const res = await fetch("/api/jobs/running");
    if (!res.ok) throw new Error(String(res.status));
    return ((await res.json()) as { jobs: RunningJob[] }).jobs ?? [];
  },
  async fetchFinal(id, course) {
    const res = await fetch(`/api/jobs/${id}?course=${encodeURIComponent(course)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { status: string; resultPath: string | null; error?: string | null };
    return { status: j.status, resultPath: j.resultPath ?? null, error: j.error ?? null };
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
  now: () => Date.now(),
};

let deps: TrackerDeps = browserDeps;
let state: TrackerState = { jobs: [], toasts: [], shown: new Set() };
const listeners = new Set<() => void>();
let timer: unknown = null;
let offVisible: (() => void) | null = null;
let polling = false;
/** Un tour demandé pendant un tour en cours (une page vient de lancer un job) : refait juste après. */
let again = false;
let started = false;

function emit(next: Partial<TrackerState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function schedule(ms: number) {
  if (timer !== null) deps.clearTimer(timer);
  timer = deps.setTimer(() => { timer = null; void poll(); }, ms);
}

async function poll(): Promise<void> {
  if (polling) { again = true; return; }
  if (deps.isHidden() && !state.jobs.length) { timer = null; return; } // reprend au retour au premier plan
  polling = true;
  try {
    for (const [key, at] of endedAt) if (deps.now() - at > ENDED_MS) endedAt.delete(key);
    const jobs = (await deps.fetchRunning()).filter((j) => !endedAt.has(jobKey(j.course, j.id)));
    const now = new Set(jobs.map((j) => jobKey(j.course, j.id)));
    const gone = state.jobs.filter((j) => !now.has(jobKey(j.course, j.id)));
    emit({ jobs });
    for (const j of gone) await settle(j);
  } catch {
    // Panne passagère : on garde l'état connu et on réessaie au rythme lent.
  } finally {
    polling = false;
    if (again) { again = false; void poll(); }
    else if (started && listeners.size) schedule(!state.jobs.length ? IDLE_POLL_MS : deps.isHidden() ? HIDDEN_POLL_MS : ACTIVE_POLL_MS);
  }
}

/** Une génération sortie de la liste : relue une fois, notifiée si elle est finie ou en échec. */
async function settle(j: RunningJob) {
  const key = jobKey(j.course, j.id);
  const final = await deps.fetchFinal(j.id, j.course).catch(() => null);
  if (!final || (final.status !== "done" && final.status !== "error")) return; // annulée, ou encore inconnue
  if (state.shown.has(key) || state.toasts.some((t) => t.key === key)) return;
  const left = unshownAt.get(key);
  if (left !== undefined && deps.now() - left < RECENTLY_SHOWN_MS) return;
  const toast: GenerationToast = {
    key, id: j.id, course: j.course, courseLabel: j.courseLabel, type: j.type,
    status: final.status === "done" ? "done" : "failed", resultPath: final.resultPath, error: final.error ?? null,
  };
  emit({ toasts: [...state.toasts, toast].slice(-TOAST_LIMIT) });
}

function start() {
  if (started) return;
  started = true;
  offVisible = deps.onVisible(() => void poll());
  void poll();
}

function stop() {
  started = false;
  if (timer !== null) deps.clearTimer(timer);
  timer = null;
  offVisible?.();
  offVisible = null;
}

export function subscribeTracker(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stop();
  };
}

export function trackerState(): TrackerState {
  return state;
}

/** Une page vient de lancer une génération : la pastille la connaît tout de suite. */
export function notifyJobStarted(): void {
  if (started) void poll();
}

/**
 * Une page affiche le suivi de ce job : la pastille ne le répète pas. Renvoie le retrait ;
 * `endShown` : la page a montré la fin du job (pas de notification en double). Une page quittée
 * pendant que le job tourne retire son suivi sans ce drapeau : sa fin sera notifiée.
 */
export function showJob(course: string, id: number): (endShown: boolean) => void {
  const key = jobKey(course, id);
  emit({ shown: new Set([...state.shown, key]) });
  return (endShown) => {
    if (endShown) unshownAt.set(key, deps.now());
    const next = new Set(state.shown);
    next.delete(key);
    emit({ shown: next });
  };
}

/**
 * Une page a vu ce job finir (fin montrée, annulation depuis son suivi) : la pastille le lâche
 * tout de suite au lieu d'attendre le tour suivant. `notify` : la page s'efface sans rien dire,
 * la notification de fin part maintenant.
 */
export function jobEnded(course: string, id: number, notify = false): void {
  const key = jobKey(course, id);
  const job = state.jobs.find((j) => jobKey(j.course, j.id) === key);
  endedAt.set(key, deps.now());
  if (!job) return;
  emit({ jobs: state.jobs.filter((j) => j !== job) });
  if (notify) void settle(job);
}

export function dismissToast(key: string): void {
  emit({ toasts: state.toasts.filter((t) => t.key !== key) });
}

/** (tests) remplace réseau, timers et visibilité ; repart d'un état vide. */
export function configureTracker(d: Partial<TrackerDeps>): void {
  stop();
  listeners.clear();
  deps = { ...browserDeps, ...d };
  state = { jobs: [], toasts: [], shown: new Set() };
  unshownAt.clear();
  endedAt.clear();
  again = false;
}
