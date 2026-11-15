import type { ChildProcess } from "node:child_process";

/**
 * ARRÊT GRACIEUX DU CONTENEUR — constat prod du 14-15/11/2026 : chaque fusion sur main
 * redéployait Railway et tuait les jobs en cours (job 20 perdu à 99 %, jobs 23 et 25 repris de
 * zéro par la pompe : 70 min et deux fois le coût pour le 25 ; quatre déploiements en trois heures).
 * Railway envoie SIGTERM à l'ancien déploiement puis SIGKILL après
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS (0 par défaut : rien ne survivait).
 *
 * Sur SIGTERM, le serveur :
 *  1. cesse de PRENDRE des jobs — un job créé ou repris pendant le drain reste en file, marqué
 *     « différé » (worker_id = 'deferred'), et le conteneur suivant le démarre à son boot ;
 *  2. laisse les workers qu'il a lancés FINIR, jusqu'à l'échéance du drain ;
 *  3. à l'échéance, arrête ceux qui tournent encore et les remet en file, différés, AVANT le
 *     SIGKILL : la reprise part de leur point de reprise (checkpoint_json) sans attendre la
 *     détection de zombie, et sans consommer de tentative (un déploiement n'est pas un échec) ;
 *  4. sort. Le serveur HTTP continue de répondre pendant tout ce temps : avec un volume, le
 *     nouveau conteneur ne démarre qu'après la sortie de l'ancien.
 *
 * Exige NEXT_MANUAL_SIG_HANDLE=1 (posé par le Dockerfile) : sinon `next start` sort dès le
 * SIGTERM, et ses workers détachés meurent avec le conteneur.
 */

export type TrackedWorker = { jobId: number; user: string; course: string; pid: number };

type State = { draining: boolean; workers: Map<number, { w: TrackedWorker; exited: Promise<void> }>; handler: ((s: NodeJS.Signals) => void) | null; signals: number };

// globalThis : une seule instance par process, même après un rechargement à chaud du module.
const g = globalThis as { __cortexDrain?: State };
function state(): State {
  return (g.__cortexDrain ??= { draining: false, workers: new Map(), handler: null, signals: 0 });
}

export function isDraining(): boolean {
  return state().draining;
}

/** Workers lancés par CE process et encore vivants. */
export function runningWorkers(): TrackedWorker[] {
  return [...state().workers.values()].map((x) => x.w);
}

/** Suit un worker lancé par ce process jusqu'à sa sortie (startWorker). */
export function trackWorker(child: ChildProcess, meta: Omit<TrackedWorker, "pid">): void {
  if (!child.pid) return;
  const pid = child.pid;
  const s = state();
  const exited = new Promise<void>((resolve) => {
    // 'exit' arrive même sur un enfant détaché et unref() ; 'error' = spawn raté, rien ne tourne.
    const done = () => { s.workers.delete(pid); resolve(); };
    child.once("exit", done);
    child.once("error", done);
  });
  s.workers.set(pid, { w: { ...meta, pid }, exited });
}

/** Marge gardée avant le SIGKILL de la plateforme : remettre les jobs en file et sortir proprement. */
const HANDOFF_MARGIN_S = 60;

/**
 * Temps accordé aux workers pour finir. CORTEX_DRAIN_SECONDS l'impose ; sinon
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS moins la marge de remise en file. 0 : aucun délai,
 * les jobs en cours sont remis en file tout de suite (la plateforme tue dans la foulée).
 */
export function drainBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const own = Number(env.CORTEX_DRAIN_SECONDS);
  if (env.CORTEX_DRAIN_SECONDS && Number.isFinite(own) && own >= 0) return own * 1000;
  const platform = Number(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS);
  if (!Number.isFinite(platform) || platform <= 0) return 0;
  // Une marge d'au plus un quart du délai : un drain court garde l'essentiel pour finir.
  return Math.max(0, platform - Math.min(HANDOFF_MARGIN_S, platform / 4)) * 1000;
}

/**
 * Attend la fin des workers suivis, au plus `budgetMs`. À l'échéance, `handOff` reçoit ceux qui
 * tournent encore (il les arrête et remet leurs jobs en file). Rend ce qui s'est passé.
 */
export async function drainWorkers(opts: { budgetMs: number; handOff: (w: TrackedWorker[]) => Promise<void>; log?: (m: string) => void }): Promise<{ finished: number; handedOff: number }> {
  const log = opts.log ?? (() => {});
  const s = state();
  const at = [...s.workers.values()];
  if (!at.length) return { finished: 0, handedOff: 0 };
  log(`${at.length} job(s) en cours : attente de leur fin (au plus ${Math.round(opts.budgetMs / 1000)} s)`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(at.map((x) => x.exited)),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, opts.budgetMs); }),
  ]);
  if (timer) clearTimeout(timer);
  const left = runningWorkers();
  if (left.length) {
    log(`échéance du drain : ${left.length} job(s) encore en cours → remis en file, repris par le prochain conteneur`);
    await opts.handOff(left).catch((e) => log(`remise en file en échec : ${(e as Error)?.message ?? e}`));
  }
  return { finished: at.length - left.length, handedOff: left.length };
}

/**
 * Installe le gestionnaire SIGTERM/SIGINT (instrumentation.ts). Un second signal sort tout de
 * suite : un Ctrl-C répété en local, ou une plateforme qui insiste, n'attend pas le drain.
 */
export function installGracefulShutdown(opts: {
  handOff: (w: TrackedWorker[]) => Promise<void>;
  onDrainStart?: () => void;
  exit?: (code: number) => void;
  log?: (m: string) => void;
  budgetMs?: () => number;
}): void {
  const s = state();
  if (s.handler) return;
  const log = opts.log ?? ((m: string) => console.log(`[drain] ${m}`));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const onSignal = (signal: NodeJS.Signals) => {
    s.signals++;
    if (s.signals > 1) {
      log(`${signal} reçu de nouveau : sortie immédiate`);
      exit(0);
      return;
    }
    s.draining = true;
    log(`${signal} reçu : plus aucun nouveau job, les jobs en cours finissent`);
    try { opts.onDrainStart?.(); } catch { /* le drain continue */ }
    const budgetMs = (opts.budgetMs ?? (() => drainBudgetMs()))();
    void drainWorkers({ budgetMs, handOff: opts.handOff, log })
      .then((r) => log(`drain terminé : ${r.finished} job(s) fini(s), ${r.handedOff} remis en file`))
      .catch((e) => log(`drain interrompu : ${(e as Error)?.message ?? e}`))
      .finally(() => exit(0));
  };
  s.handler = onSignal;
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

/** Tests : remet l'état du process à zéro (gestionnaires retirés, plus de drain). */
export function resetDrainForTests(): void {
  const h = state().handler;
  if (h) {
    process.off("SIGTERM", h);
    process.off("SIGINT", h);
  }
  g.__cortexDrain = { draining: false, workers: new Map(), handler: null, signals: 0 };
}
