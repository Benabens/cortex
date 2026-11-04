/**
 * Seuils du banc (décision de Ben, lot Q) : chaque métrique hors seuil est un échec rouge,
 * une métrique sans objet (pas de juge, pas de chrono demandé) n'est ni verte ni rouge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Metrics } from "../lib/bench/metrics";
import { checkThresholds } from "../lib/bench/thresholds";

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    delivery: { requested: 15, delivered: 15, expectedRefundMilli: 0, refundedMilli: 0, refundOk: true, providerOutage: false, refusedAsExpected: false },
    coverage: { chapters: 8, zeroChapters: 0, allowedZero: 0, perChapter: [], unmapped: 0, notions: 15, focusShare: null },
    fidelity: { judged: 15, keysChecked: 15, keysWrong: 0, keysUnsure: 0, keyAccuracy: 1, codeRuns: 0, codeWrong: 0, definitionMismatch: 0, incoherentExplanations: 0 },
    duplicates: { intra: 0, previous: 0 },
    difficulty: { distractors: 45, trivial: 2, trivialShare: 2 / 45 },
    offCourse: { offCourseRejects: 1, falseRejections: 0, falseRejectionRate: 0, leaked: 0 },
    render: { statementPdf: true, corrigePdf: true, web: true },
    perf: { totalMs: 7 * 60_000, phases: {}, calls: 20, jsonRetries: 0, providerRetries: 0, topupBatches: 0, dedupReplacements: 0, tokensIn: 1, tokensOut: 1, cacheReadTokens: 0, cacheRate: 0, costUsd: 0.5, estimated: true },
    ux: { regressions: 0, unexplainedRegressions: 0, monotone: true, etaMedianError: 0.2 },
    ...over,
  };
}

const failed = (m: Metrics, opts: Parameters<typeof checkThresholds>[1] = {}, ref?: Metrics) =>
  checkThresholds(m, opts, ref).filter((v) => v.pass === false).map((v) => v.id);

test("run conforme : aucun rouge", () => {
  assert.deepEqual(failed(metrics(), { maxMinutes: 8 }), []);
});

test("chaque seuil de Ben passe au rouge quand il est franchi", () => {
  const m = metrics({
    delivery: { requested: 15, delivered: 14, expectedRefundMilli: 67, refundedMilli: 0, refundOk: false, providerOutage: false, refusedAsExpected: false },
    coverage: { chapters: 8, zeroChapters: 1, allowedZero: 0, perChapter: [], unmapped: 0, notions: 14, focusShare: null },
    fidelity: { judged: 14, keysChecked: 14, keysWrong: 1, keysUnsure: 0, keyAccuracy: 13 / 14, codeRuns: 0, codeWrong: 0, definitionMismatch: 0, incoherentExplanations: 1 },
    duplicates: { intra: 1, previous: 1 },
    difficulty: { distractors: 42, trivial: 3, trivialShare: 3 / 42 },
    offCourse: { offCourseRejects: 4, falseRejections: 1, falseRejectionRate: 1 / 18, leaked: 0 },
    render: { statementPdf: true, corrigePdf: false, web: true },
    perf: { ...metrics().perf, totalMs: 9 * 60_000, costUsd: 0.6 },
    ux: { regressions: 0, unexplainedRegressions: 0, monotone: true, etaMedianError: 0.3 },
  });
  assert.deepEqual(failed(m, { maxMinutes: 8 }, metrics()).sort(), [
    "coverage.zeroChapters", "delivery.complete", "delivery.refund", "difficulty.trivial", "duplicates.intra", "duplicates.previous",
    "fidelity.explanations", "fidelity.keys", "offCourse.falseRejections", "perf.cost", "perf.duration", "render.pdf", "ux.eta",
  ].sort());
});

test("panne du fournisseur : la livraison incomplète n'est pas rouge, le remboursement reste exigé", () => {
  const m = metrics({ delivery: { requested: 15, delivered: 0, expectedRefundMilli: 1000, refundedMilli: 1000, refundOk: true, providerOutage: true, refusedAsExpected: false } });
  assert.deepEqual(failed(m), []);
});

test("moins de 10 questions : pas d'exigence de chapitre ; refus attendu : livraison verte", () => {
  const few = metrics({ delivery: { ...metrics().delivery, requested: 5, delivered: 5 }, coverage: { ...metrics().coverage, zeroChapters: 3 } });
  assert.deepEqual(failed(few), []);
  const refused = metrics({ delivery: { requested: 15, delivered: 0, expectedRefundMilli: 0, refundedMilli: 0, refundOk: true, providerOutage: false, refusedAsExpected: true } });
  assert.deepEqual(failed(refused, { expectRefusal: true }), []);
});

test("coût : +5 % toléré (bruit du modèle), au-delà rouge ; sans référence, sans objet", () => {
  const ref = metrics();
  assert.deepEqual(failed(metrics({ perf: { ...ref.perf, costUsd: 0.52 } }), {}, ref), []);
  assert.deepEqual(failed(metrics({ perf: { ...ref.perf, costUsd: 0.53 } }), {}, ref), ["perf.cost"]);
  assert.equal(checkThresholds(metrics(), {}).find((v) => v.id === "perf.cost")?.pass, null);
});

test("rejeu : durée, coût et temps restant sans objet (réponses instantanées), le reste reste exigé", () => {
  const m = metrics({ perf: { ...metrics().perf, totalMs: 20 * 60_000, costUsd: 9 }, ux: { regressions: 0, unexplainedRegressions: 0, monotone: true, etaMedianError: 0.9 }, duplicates: { intra: 1, previous: 0 } });
  const v = checkThresholds(m, { maxMinutes: 8, replay: true }, metrics());
  for (const id of ["perf.duration", "perf.cost", "ux.eta"]) assert.equal(v.find((x) => x.id === id)?.pass, null, id);
  assert.deepEqual(v.filter((x) => x.pass === false).map((x) => x.id), ["duplicates.intra"]);
});
