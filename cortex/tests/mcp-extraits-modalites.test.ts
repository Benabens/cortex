/**
 * MCP — extraits de recherche utiles, sources hors programme, notes de modalités d'examen.
 * Fonctions pures : la fenêtre de ~300 caractères autour du passage, le repérage d'une
 * source hors programme, et la règle qui écarte une note de format des concepts à réviser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXCERPT_CHARS, contextExcerpt, isOffProgram } from "../lib/mcp/excerpts";
import { isExamLogistics } from "../lib/course-grounding";

const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");

test("extrait : ~300 caractères autour du passage, pas les 3 mots du surlignage", () => {
  const text = `${filler(80, "avant")} La souveraineté de l'IA désigne la capacité d'un État à maîtriser ses modèles, ses données et ses puces. ${filler(80, "apres")}`;
  const ex = contextExcerpt(text, "Souveraineté IA");
  assert.ok(ex.length >= 250 && ex.length <= EXCERPT_CHARS + 10, `longueur ${ex.length} : ${ex}`);
  assert.match(ex, /«souveraineté» de l'«IA» désigne la capacité d'un État/);
  assert.match(ex, /^… /, "coupé au début");
  assert.match(ex, / …$/, "coupé à la fin");
  assert.ok(!/avant0 /.test(ex), "la fenêtre suit le passage, pas le début du texte");
});

test("extrait : accents, casse et préfixe ignorés ; le passage qui réunit le plus de termes gagne", () => {
  const text = `Valeurs isolées ici. ${filler(60, "x")} Une matrice symétrique a des valeurs propres réelles. ${filler(60, "y")}`;
  const ex = contextExcerpt(text, "MATRICE symetriques valeur");
  assert.match(ex, /«matrice» «symétrique» a des «valeurs» propres/);
});

test("extrait : texte court rendu entier ; aucun terme retrouvé → début du texte", () => {
  assert.equal(contextExcerpt("Théorème spectral : diagonalisable.", "spectral"), "Théorème «spectral» : diagonalisable.");
  const ex = contextExcerpt(`${filler(100, "mot")}`, "introuvable");
  assert.match(ex, /^mot0 mot1/);
  assert.ok(ex.length <= EXCERPT_CHARS + 2);
});

test("hors programme : par le titre ou par le début de la note", () => {
  assert.equal(isOffProgram("Lectures complémentaires (hors programme)"), true);
  assert.equal(isOffProgram("Notes", "Hors-programme : pour aller plus loin sur la souveraineté numérique."), true);
  assert.equal(isOffProgram("Extra reading", "This chapter is not examinable."), true);
  assert.equal(isOffProgram("Cours 4 — souveraineté de l'IA", "La souveraineté de l'IA est au programme de l'examen."), false);
  assert.equal(isOffProgram("Programme du cours"), false);
});

test("modalités d'examen : jamais un concept à réviser ; les notions du cours passent", () => {
  for (const t of [
    "Midterm MCQ format — half Bendahan, half Gillet",
    "Modalités d'examen",
    "Format de l'examen final",
    "Exam duration and allowed material",
    "Barème du QCM : +1 / -0,25",
    "Grille d'évaluation de l'essai",
    "Final exam: closed book, one cheat sheet allowed",
    "Number of questions in the midterm",
  ]) assert.equal(isExamLogistics(t), true, t);
  for (const t of [
    "Final value theorem",
    "Valeurs propres et diagonalisation",
    "Souveraineté de l'IA",
    "Format string vulnerability",
    "MCQ on eigenvalues",
    "Midterm review: eigenvalues",
    "Hypothesis test and critical region",
    "Le format PDF/A",
  ]) assert.equal(isExamLogistics(t), false, t);
});
