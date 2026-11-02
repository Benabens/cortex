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
  assert.match(queued.label, /En file — environ 10 min une fois lancé/);
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

