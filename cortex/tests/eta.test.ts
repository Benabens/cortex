/**
 * TEMPS RESTANT D'UNE GÉNÉRATION (lib/eta) — le suivi d'un job ne donnait qu'un
 * pourcentage. L'estimation part de la durée des derniers jobs du même type du
 * cours (médiane), à défaut d'une durée par type, et se recale sur
 * l'avancement ; un job en retard ne montre jamais un temps négatif, un job
 * repris après une coupure s'estime sur ce qu'il lui reste.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-eta-"));
process.env.CORTEX_DATA_DIR = tmp;
after(() => { delete process.env.CORTEX_DATA_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

const MIN = 60_000;

test("sans historique : durée par défaut du type, et c'est dit", async () => {
  const { estimateRemaining } = await import("../lib/eta");
  const e = estimateRemaining({ type: "qcm", status: "running", progress: 0, elapsedMs: 0, attempts: 0, historyMs: [] });
  assert.equal(e.basis, "default");
  assert.ok(e.remainingMs! > 5 * MIN && e.remainingMs! <= 20 * MIN, String(e.remainingMs));
  assert.match(e.label, /min restantes \(estimation sans historique\)/);
});

test("avec historique : médiane des derniers jobs, recalée sur l'avancement", async () => {
  const { estimateRemaining } = await import("../lib/eta");
  const e = estimateRemaining({ type: "qcm", status: "running", progress: 50, elapsedMs: 5 * MIN, attempts: 0, historyMs: [10 * MIN, 9 * MIN, 30 * MIN, 11 * MIN, 10 * MIN] });
  assert.equal(e.basis, "history");
  assert.ok(Math.abs(e.remainingMs! - 5 * MIN) <= MIN, `${e.remainingMs! / MIN} min`);
  assert.equal(e.label, "≈ 5 min restantes");
  assert.equal(estimateRemaining({ type: "qcm", status: "running", progress: 97, elapsedMs: 9.8 * MIN, attempts: 0, historyMs: [10 * MIN] }).label, "moins d'une minute");
});

test("job en retard : jamais de temps négatif, le retard est dit", async () => {
  const { estimateRemaining } = await import("../lib/eta");
  const e = estimateRemaining({ type: "qcm", status: "running", progress: 60, elapsedMs: 25 * MIN, attempts: 0, historyMs: [10 * MIN, 10 * MIN] });
  assert.equal(e.late, true);
  assert.equal(e.remainingMs, null);
  assert.match(e.label, /plus long que d'habitude/i);
});

test("réessai après une coupure : estimé sur ce qui reste à faire, pas sur le temps écoulé depuis le premier départ", async () => {
  const { estimateRemaining } = await import("../lib/eta");
  const e = estimateRemaining({ type: "qcm", status: "running", progress: 40, elapsedMs: 40 * MIN, attempts: 1, historyMs: [10 * MIN] });
  assert.equal(e.late, false);
  assert.ok(Math.abs(e.remainingMs! - 6 * MIN) <= MIN, `${e.remainingMs! / MIN} min`);
  assert.match(e.label, /reprise/);
  const queued = estimateRemaining({ type: "qcm", status: "queued", progress: 0, elapsedMs: 0, attempts: 0, historyMs: [10 * MIN] });
  assert.match(queued.label, /En file : environ 10 min une fois lancé/);
});

test("rendu du suivi : avancement, étape et temps restant", async () => {
  const { JobProgress } = await import("../components/dashboard/JobProgress");
  const html = renderToStaticMarkup(createElement(JobProgress, { label: "qcm", progress: 50, queued: false, step: "Vérification à l'aveugle…", eta: "≈ 5 min restantes" }));
  assert.match(html, /Génération en cours · qcm/);
  assert.match(html, /50 %/);
  assert.match(html, /≈ 5 min restantes/);
  assert.match(html, /Vérification à l&#x27;aveugle…/);
  const noEta = renderToStaticMarkup(createElement(JobProgress, { label: "qcm", progress: 0, queued: true, step: null, eta: null }));
  assert.match(noEta, /En file/);
});

test("jobEta lit l'historique du cours : durée des derniers jobs terminés du même type", async () => {
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { runWithCourse } = await import("../db/client");
  const { q, nowStr } = await import("../db/q");
  const jobs = await import("../lib/jobs");
  await runWithCourse("ml", async () => {
    for (const [start, end] of [["2026-11-01 10:00:00", "2026-11-01 10:10:00"], ["2026-11-01 11:00:00", "2026-11-01 11:10:00"]]) {
      const id = await jobs.createJob("qcm");
      await q.run(`UPDATE jobs SET status = 'done', created_at = ?, updated_at = ? WHERE id = ?`, start, end, id);
    }
    const id = await jobs.createJob("qcm");
    await q.run(`UPDATE jobs SET status = 'running', progress = 50, created_at = ? WHERE id = ?`, nowStr(-5 * MIN), id);
    const eta = await jobs.jobEta((await jobs.getJob(id))!);
    assert.equal(eta?.basis, "history");
    assert.equal(eta?.label, "≈ 5 min restantes");
    await q.run(`UPDATE jobs SET status = 'done' WHERE id = ?`, id);
    assert.equal(await jobs.jobEta((await jobs.getJob(id))!), null, "un job terminé n'a plus de temps restant");
  });
});


test("à avancement constant, le temps restant ne remonte pas avec le temps qui passe (étape longue à 30 %)", async () => {
  const { estimateRemaining } = await import("../lib/eta");
  const at = (min: number) => estimateRemaining({ type: "qcm", status: "running", progress: 30, elapsedMs: min * MIN, attempts: 0, historyMs: [10 * MIN] }).remainingMs!;
  assert.ok(at(5) <= at(3) && at(3) <= at(2), `${at(2) / MIN} → ${at(3) / MIN} → ${at(5) / MIN} min`);
});

test("un avancement qui précède les lots de reprise ne sous-estime pas le compte à rebours", async () => {
  const { estimateRemaining } = await import("../lib/eta");
  const e = estimateRemaining({ type: "qcm", status: "running", progress: 80, elapsedMs: 4 * MIN, attempts: 0, historyMs: [10 * MIN] });
  assert.equal(e.remainingMs, 6 * MIN, "à 4 min d'un historique de 10 min, 80 % provisoires ne doivent pas annoncer 2 min");
});

test("avancement PAR PHASE : chemin critique des phases parallèles, puis la suivante ; ne recule qu'à l'ajout d'un réessai", async () => {
  const { PhaseProgress } = await import("../lib/progress");
  // QCM (2 lots, 8 min) en parallèle des ouvertes (2, 2 min), puis le PDF (30 s).
  const w = new PhaseProgress(8, [[{ name: "QCM", units: 2, ms: 8 * MIN }, { name: "Ouvertes", units: 2, ms: 2 * MIN }], [{ name: "PDF", units: 1, ms: 0.5 * MIN }]]);
  assert.equal(w.pct(), 8);
  w.done("Ouvertes", 2);
  assert.equal(w.pct(), 8, "les ouvertes finies n'avancent rien : les QCM, plus longs, restent le chemin critique");
  w.done("QCM");
  const half = w.pct();
  assert.ok(half > 45 && half < 55, `${half} %`);
  w.add("QCM"); // un lot de comblement : seul cas où l'avancement recule
  assert.ok(w.pct() < half);
  w.done("QCM", 2);
  w.done("PDF");
  assert.equal(w.pct(), 99, "jamais 100 avant l'étape finale (le worker la lit comme « terminé »)");
});

test("durées de phase lues dans le journal des jobs terminés (« ⏱ QCM : 5 min 12 s »)", async () => {
  const { phaseDurationsFromLogs } = await import("../lib/progress");
  const logs = [
    [{ msg: "⏱ QCM : 5 min 12 s" }, { msg: "⏱ Questions ouvertes : 48 s" }, { msg: "⏱ PDF : 9 s" }],
    [{ msg: "⏱ QCM : 6 min 00 s" }, { msg: "autre étape" }],
    [{ msg: "⏱ QCM : 4 min 30 s" }],
  ];
  assert.deepEqual(phaseDurationsFromLogs(logs), { QCM: 312_000, "Questions ouvertes": 48_000, PDF: 9_000 });
});

test("worker : une ligne de journal (avancement 0) ne fait retomber ni l'avancement ni l'état d'un job", async () => {
  const { stepFields } = await import("../lib/jobs");
  const status = (p: number) => (p >= 100 ? "done" as const : p >= 45 ? "verifying" as const : "running" as const);
  assert.deepEqual(stepFields("⏱ QCM : 5 min 12 s", 0, status), { currentStep: "⏱ QCM : 5 min 12 s" });
  assert.deepEqual(stepFields("Vérification…", 70, status), { currentStep: "Vérification…", progress: 70, status: "verifying" });
});

test("historique des phases : médiane des lignes « ⏱ » des derniers jobs terminés du même type", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const jobs = await import("../lib/jobs");
  await runWithCourse("algo", async () => {
    for (const qcm of ["⏱ QCM : 4 min 00 s", "⏱ QCM : 6 min 00 s", "⏱ QCM : 5 min 00 s"]) {
      const id = await jobs.createJob("qcm");
      await jobs.logJob(id, qcm);
      await jobs.logJob(id, "⏱ PDF : 20 s");
      await q.run(`UPDATE jobs SET status = 'done' WHERE id = ?`, id);
    }
    const running = await jobs.createJob("qcm");
    await jobs.logJob(running, "⏱ QCM : 59 min 00 s");
    assert.deepEqual(await jobs.phaseHistory("qcm"), { QCM: 300_000, PDF: 20_000 }, "un job en cours ne compte pas");
  });
});

test("banc du 04/11 : la durée attendue suit la taille de la commande (temps par question), pas la seule médiane", async () => {
  const { estimateRemaining } = await import("../lib/eta");
  // Derniers jobs : 9 questions en 10 min, 9 en 12 min → ≈ 1,2 min par question ; ce job en demande 15.
  const e = estimateRemaining({ type: "qcm", status: "running", progress: 0, elapsedMs: 0, attempts: 0, historyMs: [10 * MIN, 12 * MIN], historyUnits: [9, 9], units: 15 });
  assert.equal(e.basis, "history");
  assert.ok(Math.abs(e.remainingMs! - (11 / 9) * 15 * MIN) < MIN / 10, `${e.remainingMs! / MIN} min`);
  // Sans historique : la durée par défaut aussi suit la commande (40 QCM ≠ 10 QCM).
  const small = estimateRemaining({ type: "qcm", status: "running", progress: 0, elapsedMs: 0, attempts: 0, historyMs: [], units: 10 });
  const big = estimateRemaining({ type: "qcm", status: "running", progress: 0, elapsedMs: 0, attempts: 0, historyMs: [], units: 40 });
  assert.ok(big.remainingMs! > 3 * small.remainingMs!, `${small.remainingMs! / MIN} → ${big.remainingMs! / MIN} min`);
});

test("jobEta lit la taille de chaque commande dans la cible des jobs (count + openCount)", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q, nowStr } = await import("../db/q");
  const jobs = await import("../lib/jobs");
  await runWithCourse("algo", async () => {
    const done = await jobs.createJob("qcm", JSON.stringify({ count: 8, openCount: 2 }));
    await q.run(`UPDATE jobs SET status = 'done', created_at = ?, updated_at = ? WHERE id = ?`, "2026-11-01 10:00:00", "2026-11-01 10:10:00", done);
    const id = await jobs.createJob("qcm", JSON.stringify({ count: 20, openCount: 0 }));
    await q.run(`UPDATE jobs SET status = 'running', progress = 0, created_at = ? WHERE id = ?`, nowStr(0), id);
    const eta = await jobs.jobEta((await jobs.getJob(id))!);
    // 10 questions en 10 min → 1 min par question → 20 min pour 20 questions.
    assert.equal(eta?.label, "≈ 20 min restantes");
  });
});
