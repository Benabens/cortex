/**
 * SYMBOLES ET LETTRES AU-DELÀ DE LATIN-1 DANS LES QCM ET LES QUESTIONS COMPOSÉES (audit du
 * 16/11/2026, axe 1 P1-11 et axe 3 P1-11). `esc` remplaçait par une espace tout caractère que sa
 * table ne connaissait pas : « A ⊆ B » s'imprimait « A   B » (l'énoncé devient faux), « Łukasiewicz »
 * « ukasiewicz », « 5 € » « 5  ». Un caractère qu'aucune commande ne rend ne doit plus disparaître
 * en silence : `untypesetChars` le signale, et le générateur QCM écarte la question.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { esc, untypesetChars } from "../lib/tex-escape";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tex-unicode-"));
process.env.CORTEX_DATA_DIR = tmp;
after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("ensembles, relations et flèches courantes des maths : rendus, jamais effacés", () => {
  const cases: [string, RegExp][] = [
    ["A ⊆ B", /\\subseteq/],
    ["A ⊂ B", /\\subset\b/],
    ["B ⊇ A", /\\supseteq/],
    ["x ∈ ℕ", /\\mathbb\{N\}/],
    ["n ∈ ℤ", /\\mathbb\{Z\}/],
    ["q ∈ ℚ", /\\mathbb\{Q\}/],
    ["z ∈ ℂ", /\\mathbb\{C\}/],
    ["A ∩ ∅", /\\emptyset/],
    ["p ⇔ q", /\\Leftrightarrow/],
    ["p ↔ q", /\\leftrightarrow/],
    ["f ≅ g", /\\cong/],
    ["p ∧ q ∨ r", /\\land.*\\lor/],
    ["A ∖ B", /\\setminus/],
    ["x ⇐ y", /\\Leftarrow/],
    ["a ≪ b", /\\ll\b/],
  ];
  for (const [s, re] of cases) {
    const out = esc(s);
    assert.match(out, re, `${s} → ${out}`);
    assert.deepEqual(untypesetChars(s), [], s);
  }
});

test("lettres accentuées d'Europe centrale et de Turquie : rendues par leur accent LaTeX", () => {
  assert.equal(esc("Łukasiewicz"), String.raw`\L{}ukasiewicz`);
  assert.equal(esc("Erdős"), String.raw`Erd\H{o}s`);
  assert.equal(esc("Čech"), String.raw`\v{C}ech`);
  assert.equal(esc("Dvořák"), String.raw`Dvo\v{r}ák`);
  assert.equal(esc("İstanbul, Łódź"), String.raw`\.{I}stanbul, \L{}ód\'{z}`);
  assert.equal(esc("Kraków, ąę"), String.raw`Kraków, \k{a}\k{e}`);
  for (const s of ["Łukasiewicz", "Erdős", "Čech", "Dvořák", "İstanbul", "ğış"]) assert.deepEqual(untypesetChars(s), [], s);
});

test("l'euro : « 5 € » garde son symbole", () => {
  assert.match(esc("5 €"), /5 \\texteuro\{\}/);
});

test("Latin-1 et les symboles déjà connus ne changent pas (empreintes des PDF existants)", () => {
  assert.equal(esc("Énoncé : coût ≤ 3, x ∈ ℝ, cœur"), String.raw`Énoncé : coût \ensuremath{\le} 3, x \ensuremath{\in} \ensuremath{\mathbb{R}}, c\oe{}ur`);
});

test("un caractère qu'aucune commande ne rend est signalé (et reste remplacé pour compiler)", () => {
  assert.deepEqual(untypesetChars("Le symbole ⌘ et 漢"), ["⌘", "漢"]);
  assert.equal(esc("a ⌘ b"), "a   b");
});

test("un QCM qui porte ces symboles et ces lettres compile en PDF", async (t) => {
  const { texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable()) return t.skip("tectonic/pdflatex absent");
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { runWithCourse } = await import("../db/client");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const item = {
    topic: "Ensembles", type: "scq" as const, stem: "Soit A ⊆ B ⊂ ℕ, C ∩ ∅ et p ⇔ q (Łukasiewicz, Erdős, Čech, İstanbul, 5 €).",
    options: ["A ⊇ B ∖ C", "x ∈ ℤ ∧ y ∈ ℚ ∨ z ∈ ℂ", "f ≅ g, a ≪ b, ⌊x⌋", "Dvořák ⇐ ğış"], correct: [0],
    misconceptions: ["", "a", "b", "c"], explanation: "Parce que ⊆.", verified: 1 as const,
  };
  const out = await runWithCourse("ml", () => buildQcmArtifact(4243, { items: [item], open: [] }, "2026-11-18"));
  assert.equal(out.texError, undefined, out.texError);
  assert.match(out.file, /\.pdf$/);
});

test("untypesetChars lit toutes les chaînes d'une valeur imbriquée (options, justification, bloc)", () => {
  assert.deepEqual(untypesetChars({ stem: "ok", options: ["a", "b ⌘"], justification: { key: "k", distractors: [{ option_index: 1, why_wrong: "漢" }] }, points: 3 }), ["⌘", "漢"]);
  assert.deepEqual(untypesetChars(["A ⊆ B"], null, undefined, 4), []);
});

test("une question composée dont un texte ne s'imprimerait pas est renvoyée au modèle", async () => {
  const { blockIssue } = await import("../lib/blocks");
  const short = { kind: "short", prompt: "Explain.", code: "", options: [], correct: -1, answer: "a", criteria: [{ label: "x", points: 1 }], points: 1, explanation: "" };
  const scq = (o: string) => ({ kind: "scq", prompt: "Pick.", code: "", options: ["a", "b", o, "d"], correct: 0, answer: "", criteria: [], points: 1, explanation: "" });
  assert.equal(blockIssue({ scenario: "S", parts: [scq("c"), short] }, 2, 6), null);
  assert.match(blockIssue({ scenario: "S", parts: [scq("c ⌘"), short] }, 2, 6) ?? "", /⌘/);
});

test("police Unicode chargée seulement quand le source imprime une écriture au-delà de Latin-1", async () => {
  const { withUnicodeFonts } = await import("../lib/exam-latex");
  const doc = (body: string) => `\\documentclass{article}\n% commentaire : Какая\n\\begin{document}\n${body}\n\\end{document}\n`;
  // Latin-1 (CS-202, tous les examens existants) : le source ne change pas, même avec un commentaire cyrillique.
  assert.equal(withUnicodeFonts(doc("Énoncé : coût")), doc("Énoncé : coût"));
  const ru = withUnicodeFonts(doc("Какая функция"));
  assert.match(ru, /\\usepackage\{fontspec\}[\s\S]*\\begin\{document\}/);
  assert.doesNotMatch(ru, /xeCJK/);
  assert.match(withUnicodeFonts(doc("哪个函数")), /\\usepackage\{xeCJK\}/);
  assert.equal(withUnicodeFonts(ru), ru, "déjà chargée : rien de plus");
});
