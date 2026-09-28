/**
 * PRÉ-LANCEMENT 11 (suite) — le suivi d'un job était sondé toutes les 1,8 s par
 * CHAQUE composant monté (six points dans l'app), avec un fetch brut qui
 * contournait la déduplication : deux composants suivant le même job doublaient
 * les requêtes, et rien ne s'arrêtait quand l'onglet passait en arrière-plan.
 * À ~33 requêtes/minute par sondeur, quelques onglets suffisaient à franchir la
 * limite de bordure (240/min) et à renvoyer des 429 sur tout.
 * Un seul sondeur partagé par job, en pause quand l'onglet est caché.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

type Timer = { fn: () => void; ms: number; id: number };

function harness() {
  let nextId = 1;
  const timers = new Map<number, Timer>();
  let hidden = false;
  const visibilityListeners = new Set<() => void>();
  const fetched: string[] = [];
  let status = "running";
  return {
    fetched,
    setStatus: (s: string) => { status = s; },
    hide() { hidden = true; },
    show() { hidden = false; for (const cb of [...visibilityListeners]) cb(); },
    /** Déclenche tous les timers en attente (un « tick »). */
    tick() {
      const due = [...timers.values()];
      timers.clear();
      for (const t of due) t.fn();
    },
    pending: () => timers.size,
    deps: {
      fetchJob: async (jobId: number, course: string) => {
        fetched.push(`${course}#${jobId}`);
        return { id: jobId, type: "exam", status, progress: 10, currentStep: null, resultPath: null };
      },
      setTimer: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { fn, ms, id }); return id; },
      clearTimer: (h: unknown) => { timers.delete(h as number); },
      isHidden: () => hidden,
      onVisible: (cb: () => void) => { visibilityListeners.add(cb); return () => visibilityListeners.delete(cb); },
    },
  };
}

let h: ReturnType<typeof harness>;
beforeEach(async () => {
  h = harness();
  const { configureJobWatch, resetJobWatch } = await import("../lib/ux/job-watch");
  resetJobWatch();
  configureJobWatch(h.deps);
});

test("deux abonnés au MÊME job → un seul appel réseau par tour", async () => {
  const { watchJob } = await import("../lib/ux/job-watch");
  const seenA: string[] = [];
  const seenB: string[] = [];
  const offA = watchJob(7, "ml", (j) => seenA.push(j.status));
  const offB = watchJob(7, "ml", (j) => seenB.push(j.status));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.fetched, ["ml#7"], "un seul appel malgré deux abonnés");
  assert.deepEqual(seenA, ["running"]);
  assert.deepEqual(seenB, ["running"], "les deux reçoivent l'état, sans second appel");
  h.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetched.length, 2, "un appel par tour, pas deux");
  offA(); offB();
});

test("deux jobs différents → deux sondeurs distincts", async () => {
  const { watchJob } = await import("../lib/ux/job-watch");
  const off1 = watchJob(1, "ml", () => {});
  const off2 = watchJob(2, "ml", () => {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.fetched.sort(), ["ml#1", "ml#2"]);
  off1(); off2();
});

test("le dernier abonné parti, le sondage s'arrête", async () => {
  const { watchJob } = await import("../lib/ux/job-watch");
  const offA = watchJob(7, "ml", () => {});
  const offB = watchJob(7, "ml", () => {});
  await new Promise((r) => setImmediate(r));
  offA();
  h.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetched.length, 2, "il reste un abonné : le sondage continue");
  offB();
  assert.equal(h.pending(), 0, "plus personne : aucun tour programmé");
  h.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetched.length, 2, "aucun appel après le départ du dernier abonné");
});

test("onglet caché : aucun appel, reprise immédiate au retour", async () => {
  const { watchJob } = await import("../lib/ux/job-watch");
  const off = watchJob(7, "ml", () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetched.length, 1);
  h.hide();
  h.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetched.length, 1, "onglet caché : on ne sonde pas");
  h.show();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetched.length, 2, "retour au premier plan : on rattrape tout de suite");
  off();
});

test("job terminé : plus aucun tour ; un abonné tardif reçoit l'état connu sans appel", async () => {
  const { watchJob } = await import("../lib/ux/job-watch");
  h.setStatus("done");
  const off = watchJob(7, "ml", () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.pending(), 0, "un job fini ne se sonde plus");
  const late: string[] = [];
  const off2 = watchJob(7, "ml", (j) => late.push(j.status));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(late, ["done"], "l'abonné tardif est servi depuis le dernier état connu");
  assert.equal(h.fetched.length, 1, "sans nouvel appel");
  off(); off2();
});

test("useJob s'appuie sur le sondeur partagé (plus de fetch par composant)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("lib/ux/api.tsx", "utf8");
  const useJob = src.slice(src.indexOf("export function useJob"));
  assert.match(useJob, /watchJob\(/, "le crochet s'abonne au sondeur partagé");
  assert.ok(!/fetch\(/.test(useJob), "aucun fetch propre au composant");
});
