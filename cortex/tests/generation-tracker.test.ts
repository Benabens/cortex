/**
 * SUIVI GLOBAL DES GÉNÉRATIONS (lib/ux/generation-tracker) — la pastille et la notification de
 * fin. Réseau, timers et visibilité injectés : on fait avancer les tours à la main.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVE_POLL_MS, HIDDEN_POLL_MS, IDLE_POLL_MS, configureTracker, dismissToast, notifyJobStarted, showJob, subscribeTracker, trackerState, type RunningJob } from "../lib/ux/generation-tracker";

const running = (id: number, course = "algo"): RunningJob => ({
  id, course, courseLabel: "Algorithmique", type: "qcm", status: "running", progress: 40,
  currentStep: "Rédaction des questions", stepInfo: { key: "stage", stage: "write" }, eta: null, etaRange: null, createdAt: "2026-11-24 10:00:00",
});

function harness() {
  const h = {
    list: [] as RunningJob[],
    finals: new Map<string, { status: string; resultPath: string | null; error?: string | null }>(),
    hidden: false,
    calls: 0,
    clock: 0,
    timers: [] as { fn: () => void; ms: number }[],
    visible: [] as (() => void)[],
  };
  configureTracker({
    fetchRunning: async () => { h.calls++; return h.list; },
    fetchFinal: async (id, course) => h.finals.get(`${course}:${id}`) ?? null,
    setTimer: (fn, ms) => { const t = { fn, ms }; h.timers.push(t); return t; },
    clearTimer: (t) => { h.timers = h.timers.filter((x) => x !== t); },
    isHidden: () => h.hidden,
    onVisible: (cb) => { h.visible.push(cb); return () => { h.visible = h.visible.filter((x) => x !== cb); }; },
    now: () => h.clock,
  });
  return h;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Déclenche le prochain tour programmé et attend sa fin. */
async function tick(h: ReturnType<typeof harness>) {
  const t = h.timers.shift();
  assert.ok(t, "un tour doit être programmé");
  t.fn();
  await flush(); await flush();
}

test("une génération en cours est connue au premier tour, rythme rapide puis lent", async () => {
  const h = harness();
  h.list = [running(7)];
  const off = subscribeTracker(() => {});
  await flush(); await flush();
  assert.deepEqual(trackerState().jobs.map((j) => j.id), [7]);
  assert.equal(h.timers[0].ms, ACTIVE_POLL_MS);
  h.list = [];
  h.finals.set("algo:7", { status: "done", resultPath: "/mock/12" });
  await tick(h);
  assert.equal(h.timers[0].ms, IDLE_POLL_MS);
  off();
  assert.equal(h.timers.length, 0, "plus aucun abonné : plus de sondage");
});

test("fin d'une génération suivie ailleurs : une notification, avec le résultat", async () => {
  const h = harness();
  h.list = [running(7)];
  const off = subscribeTracker(() => {});
  await flush(); await flush();
  h.list = [];
  h.finals.set("algo:7", { status: "done", resultPath: "/mock/12" });
  await tick(h);
  const [toast] = trackerState().toasts;
  assert.equal(toast.status, "done");
  assert.equal(toast.resultPath, "/mock/12");
  dismissToast(toast.key);
  assert.equal(trackerState().toasts.length, 0);
  off();
});

test("échec notifié ; annulation tue, pas de notification", async () => {
  const h = harness();
  h.list = [running(1), running(2)];
  const off = subscribeTracker(() => {});
  await flush(); await flush();
  h.list = [];
  h.finals.set("algo:1", { status: "error", resultPath: null });
  h.finals.set("algo:2", { status: "canceled", resultPath: null });
  await tick(h);
  assert.deepEqual(trackerState().toasts.map((t) => [t.id, t.status]), [[1, "failed"]]);
  off();
});

test("la page qui montre le job : pas de pastille en double, pas de notification à sa fin", async () => {
  const h = harness();
  h.list = [running(7)];
  const off = subscribeTracker(() => {});
  await flush(); await flush();
  const unshow = showJob("algo", 7);
  assert.ok(trackerState().shown.has("algo:7"));
  // La page retire son suivi à la fin du job, juste avant que le sondeur ne le voie partir.
  h.clock = 1000;
  unshow(true);
  h.list = [];
  h.finals.set("algo:7", { status: "done", resultPath: null });
  await tick(h);
  assert.equal(trackerState().toasts.length, 0);
  off();
});

test("page quittée pendant la génération : sa fin est notifiée", async () => {
  const h = harness();
  h.list = [running(7)];
  const off = subscribeTracker(() => {});
  await flush(); await flush();
  const unshow = showJob("algo", 7);
  unshow(false);
  h.list = [];
  h.finals.set("algo:7", { status: "done", resultPath: null });
  await tick(h);
  assert.equal(trackerState().toasts.length, 1);
  off();
});

test("échec : la notification porte la cause", async () => {
  const h = harness();
  h.list = [running(7)];
  const off = subscribeTracker(() => {});
  await flush(); await flush();
  h.list = [];
  h.finals.set("algo:7", { status: "error", resultPath: null, error: "Le moteur ne répond pas." });
  await tick(h);
  assert.equal(trackerState().toasts[0]?.error, "Le moteur ne répond pas.");
  off();
});

test("onglet caché : sondage lent tant qu'une génération tourne, suspendu sinon ; au retour, un tour tout de suite", async () => {
  const h = harness();
  h.list = [running(7)];
  const off = subscribeTracker(() => {});
  await flush(); await flush();
  h.hidden = true;
  await tick(h);
  assert.equal(h.timers.at(-1)?.ms, HIDDEN_POLL_MS, "une génération tourne : un tour toutes les 20 s");
  // Elle finit onglet caché : la notification est prête pour le retour (titre de l'onglet).
  h.list = [];
  h.finals.set("algo:7", { status: "done", resultPath: null });
  await tick(h);
  assert.equal(trackerState().toasts.length, 1);
  // Plus rien ne tourne : le tour lent suivant s'arrête sans en reprogrammer.
  await tick(h);
  assert.equal(h.timers.length, 0, "onglet caché sans génération : aucun tour programmé");
  h.hidden = false;
  h.list = [running(8)];
  h.visible[0]();
  await flush(); await flush();
  assert.equal(trackerState().jobs.length, 1, "au retour : un tour tout de suite");
  off();
});

test("une page lance un job pendant un tour : un second tour suit, le job n'attend pas 45 s", async () => {
  const h = harness();
  const off = subscribeTracker(() => {});
  notifyJobStarted(); // le premier tour est encore en vol
  h.list = [running(9)];
  await flush(); await flush(); await flush();
  assert.equal(h.calls, 2);
  assert.equal(trackerState().jobs.length, 1);
  off();
});
