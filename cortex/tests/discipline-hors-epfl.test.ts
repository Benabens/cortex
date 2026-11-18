/**
 * DISCIPLINE D'UN COURS HORS EPFL (audit du 16/11/2026, axe 1 P1-10 et axe 3 P1-8). Seuls quelques
 * préfixes de code étaient connus : ENGL 101, PSYC 210 ou LING 120 tombaient en « stem » sans corpus
 * pour trancher, et l'étudiant recevait des problèmes à calculs au lieu de questions de sciences
 * humaines. Le code tranche quand il est connu, puis le nom du cours, puis le corpus.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inferDiscipline } from "../lib/exam-format";

const PROSE = "La révolution industrielle transforme la société, l'économie et la pensée politique de l'Europe. ".repeat(6);
const MATHS = "Soit f(x) = x^2 + 3x - 1, calculer f'(x) = 2x + 3 et ∫ f = x^3/3 + 3x^2/2 - x. ".repeat(6);

test("codes de sciences humaines des universités américaines et britanniques, sans corpus", () => {
  for (const code of ["ENGL 101", "PSYC 210", "LING 120", "ANTH 101", "POLS 200", "SOCI 101", "RELS 110", "CLAS 101", "MUS 120", "ARTH 201", "EDUC 300", "FREN 210"])
    assert.equal(inferDiscipline({ code }), "humanities", code);
});

test("codes scientifiques des universités américaines et britanniques, même sur un corpus en prose", () => {
  for (const code of ["STA 101", "CPSC 223", "CMSC 131", "CSCI 1300", "ECE 250", "PHY 141", "BIOL 101", "ASTR 100", "EECS 281", "MTH 132", "ENGR 100"])
    assert.equal(inferDiscipline({ code, sample: PROSE }), "stem", code);
});

test("sans code reconnu ni corpus : le nom du cours tranche", () => {
  assert.equal(inferDiscipline({ code: "", name: "Modern History" }), "humanities");
  assert.equal(inferDiscipline({ code: "L2-HIST", name: "Histoire contemporaine" }), "humanities");
  assert.equal(inferDiscipline({ code: "", name: "Introduction à la sociologie" }), "humanities");
  assert.equal(inferDiscipline({ code: "", name: "Calculus II" }), "stem");
  assert.equal(inferDiscipline({ code: "L2-PROBA", name: "Probabilités" }), "stem");
  assert.equal(inferDiscipline({ code: "", name: "Algorithmique et programmation" }), "stem");
});

test("un nom ambigu (les deux familles) ne tranche pas : le corpus décide", () => {
  assert.equal(inferDiscipline({ code: "", name: "History of Mathematics", sample: PROSE }), "humanities");
  assert.equal(inferDiscipline({ code: "", name: "History of Mathematics", sample: MATHS }), "stem");
});

test("le code reste prioritaire sur le nom, et un mot n'est pas un préfixe de code", () => {
  assert.equal(inferDiscipline({ code: "MATH 250", name: "Philosophy of Mathematics" }), "stem");
  assert.equal(inferDiscipline({ code: "ENGLISH", name: "", sample: MATHS }), "stem", "ENGLISH n'est pas ENGL suivi d'un numéro");
});
