import test from "node:test";
import assert from "node:assert/strict";
import { sampleMolds, pickCoverage, type ExamDna } from "../lib/exam-dna";
import type { MoldKind } from "../lib/molds";

/**
 * Contrat de l'échantillonnage par MOULE + couverture LARGE.
 * Purs (aucune DB/LLM), déterministes.
 */

function dnaWith(molds: [MoldKind, number][]): ExamDna {
  const total = molds.reduce((s, [, c]) => s + c, 0);
  return {
    version: 1,
    course: "t",
    molds: molds.map(([mold, count]) => ({ mold, count, share_pct: Math.round((count / total) * 1000) / 10 })),
    figures: { kinds: [], pages_scanned: 0, pages_with_figures: 0, figure_share_pct: 0, exercises_with_figure_pct: 0, scanned: {} },
    difficulty: null,
    totals: { exercises: total, classified: total },
    detected_at: "",
  };
}

test("sampleMolds : proportions respectées (plus fort reste), somme exacte", () => {
  const dna = dnaWith([["statement_truefalse", 50], ["formula_computation", 30], ["figure_reading", 20]]);
  const s = sampleMolds(dna, 10);
  assert.equal(s.length, 10);
  const count = (m: string) => s.filter((x) => x === m).length;
  assert.equal(count("statement_truefalse"), 5);
  assert.equal(count("formula_computation"), 3);
  assert.equal(count("figure_reading"), 2);
});

test("sampleMolds : déterministe + entrelacé (pas 5 identiques d'affilée)", () => {
  const dna = dnaWith([["statement_truefalse", 50], ["formula_computation", 30], ["figure_reading", 20]]);
  assert.deepEqual(sampleMolds(dna, 10), sampleMolds(dna, 10));
  const s = sampleMolds(dna, 10);
  let maxRun = 1, run = 1;
  for (let i = 1; i < s.length; i++) { run = s[i] === s[i - 1] ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
  assert.ok(maxRun <= 3, `entrelacement insuffisant (run de ${maxRun}) : ${s.join(",")}`);
});

test("sampleMolds : sans ADN → nulls (comportement d'avant) ; filtre only", () => {
  assert.deepEqual(sampleMolds(null, 3), [null, null, null]);
  const dna = dnaWith([["proof_analysis", 5], ["statement_truefalse", 5]]);
  const s = sampleMolds(dna, 4, { only: ["proof_analysis"] });
  assert.ok(s.every((m) => m === "proof_analysis"));
});

test("sampleMolds : n plus grand que les données → jamais de crash, somme exacte", () => {
  const dna = dnaWith([["design", 1], ["derivation", 2]]);
  const s = sampleMolds(dna, 9);
  assert.equal(s.length, 9);
  assert.equal(s.filter((x) => x === "derivation").length, 6);
  assert.equal(s.filter((x) => x === "design").length, 3);
});

test("pickCoverage : la LONGUE TRAÎNE apparaît (fin de liste incluse)", () => {
  const items = Array.from({ length: 30 }, (_, i) => `t${i}`);
  const picked = pickCoverage(items, 14);
  assert.equal(picked.length, 14);
  // tête préservée…
  assert.ok(picked.includes("t0") && picked.includes("t1"));
  // …ET la traîne échantillonnée : au moins un sujet du dernier tiers (t20+), impossible avec LIMIT 14.
  assert.ok(picked.some((t) => Number(t.slice(1)) >= 20), `traîne absente : ${picked.join(",")}`);
});

test("pickCoverage : moins de sujets que de slots → tous couverts (cyclique)", () => {
  const picked = pickCoverage(["a", "b", "c"], 7);
  assert.equal(picked.length, 7);
  for (const t of ["a", "b", "c"]) assert.ok(picked.includes(t));
});
