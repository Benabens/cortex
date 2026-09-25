import test from "node:test";
import assert from "node:assert/strict";
import { MOLD_KINDS, MOLD_DEFS, moldTaxonomyBlock, normalizeMold, figureKindKey, normalizeFigureKind } from "../lib/molds";

/**
 * Contrat de la taxonomie GÉNÉRIQUE des moules.
 * Hermétique (aucun LLM, aucune DB).
 */

test("taxonomie : 10 moules, tous définis, bloc prompt complet", () => {
  assert.equal(MOLD_KINDS.length, 10);
  for (const m of MOLD_KINDS) {
    assert.ok(MOLD_DEFS[m] && MOLD_DEFS[m].length > 10, `définition manquante pour ${m}`);
    assert.ok(moldTaxonomyBlock().includes(m));
  }
});

test("taxonomie : GÉNÉRIQUE — aucune définition ne nomme une matière", () => {
  // Garde-fou zéro-hardcode : les définitions ne doivent contenir aucun nom de cours/matière.
  const banned = /cs-?202|cs-?233|cs-?250|machine\s*learning|\balgo(rithm(s|es|ique))?\b|tcp|inode|réseau|network|gradient/i;
  for (const m of MOLD_KINDS) {
    // exception : « gradient » apparaît comme EXEMPLE générique de dérivation pas-à-pas — toléré ?
    // Non : on garde le garde-fou strict sauf la parenthèse d'exemples de `derivation`.
    const def = MOLD_DEFS[m].replace(/\(gradient, récurrence, équation, expression\)/, "");
    assert.ok(!banned.test(def), `définition de ${m} contient un terme de matière : ${MOLD_DEFS[m]}`);
  }
});

test("normalizeMold : valide, insensible casse/espaces, rejette hors-taxonomie", () => {
  assert.equal(normalizeMold("code_trace"), "code_trace");
  assert.equal(normalizeMold("  Figure_Reading "), "figure_reading");
  assert.equal(normalizeMold("figure-reading"), "figure_reading");
  assert.equal(normalizeMold("statement true/false"), null); // pas de fuzzy : hors-taxonomie → null
  assert.equal(normalizeMold("banana"), null);
  assert.equal(normalizeMold(42), null);
  assert.equal(normalizeMold(null), null);
});

test("figureKindKey : fusion accent/casse/ponctuation", () => {
  assert.equal(figureKindKey("Scatter plot"), figureKindKey("scatter-plot"));
  assert.equal(figureKindKey("État-machine"), figureKindKey("etat machine"));
  assert.notEqual(figureKindKey("tree"), figureKindKey("graph"));
});

test("normalizeFigureKind : nettoie, borne, rejette le vide", () => {
  assert.equal(normalizeFigureKind("  decision   boundary  "), "decision boundary");
  assert.equal(normalizeFigureKind("ab"), null);
  assert.equal(normalizeFigureKind(null), null);
  assert.equal(normalizeFigureKind("x".repeat(100))!.length, 60);
});
