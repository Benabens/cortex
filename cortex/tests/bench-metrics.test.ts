/**
 * Mesures du banc (lib/bench/metrics) sur des runs exportés : des faits relevés, aucune
 * dépendance au modèle. Chaque valeur attendue vient d'un exemple calculé à la main.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureRun } from "../lib/bench/metrics";
import type { BenchItem, BenchRun } from "../lib/bench/types";

const qcm = (idx: number, topic: string | null = null): BenchItem => ({ idx, kind: "qcm", topic, stem: `Q${idx}`, options: ["a", "b", "c", "d"], correct: [0], explanation: "e" });

function run(over: Partial<BenchRun> = {}): BenchRun {
  return {
    caseId: "x", commit: "c", provider: "claude-code", startedAt: "2026-11-04T10:00:00.000Z", finishedAt: "2026-11-04T10:06:00.000Z",
    request: { job: "qcm", target: { count: 15 }, requested: 15 },
    job: { id: 1, status: "done", error: null, log: [], createdAt: "2026-11-04 10:00:00", updatedAt: "2026-11-04 10:06:00", resultId: 7 },
    samples: [],
    exam: { id: 7, kind: "qcm", items: Array.from({ length: 15 }, (_, i) => qcm(i)) },
    render: { statement: null, corrige: null, web: { ok: true, items: 15 } },
    plan: { chapters: [], topicChapter: {} },
    previous: [], usage: [], calls: [], rates: { opus: { inPerM: 3, outPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 } }, billing: { debited: true, refundedMilli: 0 }, rejected: [],
    ...over,
  };
}

test("livraison complète : 15/15, rien à rendre, remboursement juste", () => {
  const m = measureRun(run()).delivery;
  assert.deepEqual([m.delivered, m.requested, m.expectedRefundMilli, m.refundOk], [15, 15, 0, true]);
});

test("livraison incomplète : 12/15 → 200 ‰ à rendre ; rendu 200 juste, rendu 0 faux", () => {
  const items = Array.from({ length: 12 }, (_, i) => qcm(i));
  const ok = measureRun(run({ exam: { id: 7, kind: "qcm", items }, billing: { debited: true, refundedMilli: 200 } })).delivery;
  assert.deepEqual([ok.delivered, ok.expectedRefundMilli, ok.refundOk], [12, 200, true]);
  const ko = measureRun(run({ exam: { id: 7, kind: "qcm", items }, billing: { debited: true, refundedMilli: 0 } })).delivery;
  assert.equal(ko.refundOk, false);
});

test("job échoué : rien livré, tout est dû ; panne du fournisseur repérée dans l'erreur", () => {
  const failed = run({ job: { id: 1, status: "failed", error: "Le fournisseur du modèle est surchargé (OVERLOADED).", log: [], createdAt: "", updatedAt: "", resultId: null }, exam: null, billing: { debited: true, refundedMilli: 1000 } });
  const m = measureRun(failed).delivery;
  assert.deepEqual([m.delivered, m.expectedRefundMilli, m.refundOk, m.providerOutage], [0, 1000, true, true]);
});

test("refus attendu avant débit : compté comme réussi, rien à rendre", () => {
  const refused = run({ request: { job: "exam", target: {}, requested: 15, expectRefusal: true }, refusal: "Format d'examen inconnu", job: null, exam: null, billing: { debited: false, refundedMilli: 0 } });
  const m = measureRun(refused).delivery;
  assert.deepEqual([m.refusedAsExpected, m.expectedRefundMilli, m.refundOk], [true, 0, true]);
});

const plan5 = { chapters: [1, 2, 3, 4, 5].map((id) => ({ id, seq: id, title: `Chapitre ${id}` })), topicChapter: { a: 1, b: 2, c: 3, d: 4, e: 5 } as Record<string, number | null> };

test("couverture : 15 QCM sur 4 des 5 chapitres → un chapitre à 0, aucun permis", () => {
  const topics = ["a", "b", "c", "d"];
  const items = Array.from({ length: 15 }, (_, i) => qcm(i, topics[i % 4]));
  const c = measureRun(run({ plan: plan5, exam: { id: 7, kind: "qcm", items } })).coverage;
  assert.deepEqual([c.chapters, c.zeroChapters, c.allowedZero, c.unmapped], [5, 1, 0, 0]);
  assert.deepEqual(c.perChapter.map((p) => p.n), [4, 4, 4, 3, 0]);
});

test("couverture : le chapitre donné par le juge prime sur le libellé de la notion ; plus de chapitres que de questions", () => {
  const items = Array.from({ length: 3 }, (_, i) => qcm(i, "inconnue"));
  const verdicts = { rubric: "v", judgeModel: "m", items: items.map((it) => ({ idx: it.idx, chapter: it.idx + 1, notion: "n", key: "right" as const, explanation: "consistent" as const, definition: "na" as const, offCourse: false, distractors: 3, trivialDistractors: 0 })), duplicatesIntra: [], duplicatesPrevious: [], rejected: [] };
  const c = measureRun(run({ plan: plan5, request: { job: "qcm", target: { count: 3 }, requested: 3 }, exam: { id: 7, kind: "qcm", items } }), verdicts).coverage;
  assert.deepEqual([c.zeroChapters, c.allowedZero, c.unmapped], [2, 2, 0]);
});

test("couverture d'un focus : part des questions sur le chapitre demandé", () => {
  const items = Array.from({ length: 10 }, (_, i) => qcm(i, i < 8 ? "c" : "a"));
  const c = measureRun(run({ plan: plan5, request: { job: "qcm", target: { count: 10, focus: "chapitre 3" }, requested: 10 }, exam: { id: 7, kind: "qcm", items } })).coverage;
  assert.equal(c.focusShare, 0.8);
});

test("qualité jugée : clés, explications, définitions, doublons, distracteurs, hors cours", () => {
  const items = Array.from({ length: 10 }, (_, i) => qcm(i, "a"));
  const base = { chapter: 1, notion: "n", key: "right" as const, explanation: "consistent" as const, definition: "na" as const, offCourse: false, distractors: 3, trivialDistractors: 0 };
  const verdicts = {
    rubric: "v", judgeModel: "m",
    items: items.map((it) => ({ ...base, idx: it.idx, notion: `n${it.idx}` }))
      .map((v) => v.idx === 2 ? { ...v, key: "wrong" as const } : v.idx === 3 ? { ...v, key: "unsure" as const, explanation: "inconsistent" as const } : v.idx === 4 ? { ...v, definition: "mismatch" as const, trivialDistractors: 2 } : v.idx === 5 ? { ...v, offCourse: true, code: { ran: true, ok: false, detail: "sortie 3, clé 4" } } : v),
    duplicatesIntra: [[0, 7]] as [number, number][], duplicatesPrevious: [9],
    rejected: [{ idx: 0, offCourseReject: true, falseRejection: true }, { idx: 1, offCourseReject: true, falseRejection: false }, { idx: 2, offCourseReject: false, falseRejection: false }],
  };
  const rejected = [{ stem: "r0", reason: "hors cours" }, { stem: "r1", reason: "hors cours" }, { stem: "r2", reason: "clé contestée" }];
  const m = measureRun(run({ exam: { id: 7, kind: "qcm", items }, request: { job: "qcm", target: { count: 10 }, requested: 10 }, rejected }), verdicts);
  assert.deepEqual(m.fidelity, { judged: 10, keysChecked: 9, keysWrong: 1, keysUnsure: 1, keyAccuracy: 8 / 9, codeRuns: 1, codeWrong: 1, definitionMismatch: 1, incoherentExplanations: 1 });
  assert.deepEqual(m.duplicates, { intra: 1, previous: 1 });
  assert.deepEqual(m.difficulty, { distractors: 30, trivial: 2, trivialShare: 2 / 30 });
  // Hors cours : 2 rejets « hors cours » sur 12 items vus (10 livrés + 2 écartés), dont 1 à tort ; 1 livré jugé hors cours.
  assert.deepEqual(m.offCourse, { offCourseRejects: 2, falseRejections: 1, falseRejectionRate: 1 / 12, leaked: 1 });
});

test("rendu : PDF énoncé et corrigé compilés avec du texte, page en ligne complète", () => {
  const pdf = (file: string, pages: number) => ({ file, exists: pages > 0, pages, textChars: pages * 900 });
  const ok = measureRun(run({ render: { statement: pdf("e.pdf", 4), corrige: pdf("c.pdf", 6), web: { ok: true, items: 15 } } })).render;
  assert.deepEqual(ok, { statementPdf: true, corrigePdf: true, web: true });
  const ko = measureRun(run({ render: { statement: pdf("e.pdf", 4), corrige: null, web: { ok: true, items: 12 } } })).render;
  assert.deepEqual(ko, { statementPdf: true, corrigePdf: false, web: false });
});

test("performance : durées par phase, appels, réessais, tokens et coût API estimés avec le cache de prompt", () => {
  const log = [
    { t: "2026-11-04T10:05:00.000Z", msg: "⏱ QCM : 4 min 30 s" },
    { t: "2026-11-04T10:05:10.000Z", msg: "3 QCM manquant(s) → 1 lot(s) de comblement" },
    { t: "2026-11-04T10:05:40.000Z", msg: "⏱ PDF : 20 s" },
    { t: "2026-11-04T10:06:00.000Z", msg: "⏱ Total : 6 min 00 s" },
  ];
  const at = Date.parse("2026-11-04T10:00:00.000Z");
  // Deux appels au même système (4 000 car. = 1 000 tokens) à 1 min d'écart : écriture puis lecture du cache.
  const calls = [
    { site: "generateQcmBatch", model: "opus", promptChars: 8000, systemChars: 4000, outputChars: 4000, ms: 30_000, systemHash: "s1", at },
    { site: "generateQcmBatch", model: "opus", promptChars: 8000, systemChars: 4000, outputChars: 4000, ms: 30_000, systemHash: "s1", at: at + 60_000 },
    { site: "verifyQcmBatch", model: "opus", promptChars: 4000, systemChars: 0, outputChars: 2000, ms: 10_000, jsonRetry: true, at: at + 120_000 },
  ];
  const job = { id: 1, status: "done", error: null, log, createdAt: "2026-11-04 10:00:00", updatedAt: "2026-11-04 10:06:00", resultId: 7 };
  const p = measureRun(run({ job, calls })).perf;
  assert.equal(p.totalMs, 360_000);
  assert.deepEqual(p.phases, { QCM: 270_000, PDF: 20_000, Total: 360_000 });
  assert.deepEqual([p.calls, p.jsonRetries, p.topupBatches], [3, 1, 1]);
  // Entrée (≈ 4 car./token) : 3 000 + 3 000 + 1 000 tokens, dont le système du 2e appel (1 000) lu en cache ;
  // sortie 1 000 + 1 000 + 500.
  assert.deepEqual([p.tokensIn, p.tokensOut, p.cacheReadTokens], [7000, 2500, 1000]);
  assert.equal(p.cacheRate, 1 / 7);
  // Coût : 5 000 non cachés × 3 + 1 000 écrits × 3,75 + 1 000 lus × 0,3 + 2 500 en sortie × 15 (par million).
  assert.equal(Math.round(p.costUsd * 1e6), 15_000 + 3750 + 300 + 37_500);
  assert.equal(p.estimated, true);
});

test("UX : avancement monotone sauf réessai annoncé ; erreur médiane du temps restant", () => {
  const log = [{ t: "2026-11-04T10:03:00.000Z", msg: "2 QCM manquant(s) → 1 lot(s) de comblement" }];
  const job = { id: 1, status: "done", error: null, log, createdAt: "2026-11-04 10:00:00", updatedAt: "2026-11-04 10:10:00", resultId: 7 };
  // Durée réelle 600 s. Restant réel aux relevés : 500, 400, 300, 200 s ; affiché : 500, 300, 450, null (en retard).
  const samples = [
    { t: 100_000, progress: 10, status: "running", etaMs: 500_000, late: false, step: "" },
    { t: 200_000, progress: 40, status: "running", etaMs: 300_000, late: false, step: "" },
    { t: 300_000, progress: 35, status: "running", etaMs: 450_000, late: false, step: "" },
    { t: 400_000, progress: 30, status: "running", etaMs: null, late: true, step: "" },
  ];
  const ux = measureRun(run({ job, samples, startedAt: "2026-11-04T10:00:00.000Z" })).ux;
  // 40 → 35 suit le comblement annoncé à 180 s ; 35 → 30 n'a aucune cause.
  assert.deepEqual([ux.regressions, ux.unexplainedRegressions, ux.monotone], [2, 1, false]);
  // Erreurs : 0, 0,25, 0,5, 1 (en retard = 100 %) → médiane 0,375.
  assert.equal(ux.etaMedianError, 0.375);
});
