/**
 * RENDU D'UN EXAMEN ÉCRIT HORS CS-202 (prod du 13/11, test-e2e-calcul-matriciel,
 * format déclaré : 60 min, sans documents, en français). Le PDF reprenait la garde
 * de CS-202 en anglais (« You have 3 hours », notes autorisées), l'encadré
 * « FOR ALL STUDENTS », des sous-questions 1.x sous la question 2 et un symbole
 * cassé pour l'indicatrice 𝟙[z>0].
 * Verrouillé au rendu (renderExamTex) ; le rendu de CS-202 reste byte-identique
 * (empreinte canonique de la CI, scripts/regression-cs202.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-entete-"));
process.env.CORTEX_DATA_DIR = tmp;

let courseFr = "";
let courseEn = "";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const fr = buildCourseRow({ name: "Calcul matriciel", code: "TEST-E2E", language: "fr", examFormat: { kind: "exercises", durationMin: 60, documents: "none" } }, "owner");
  await insertCourse(fr);
  const en = buildCourseRow({ name: "Linear Algebra", code: "MATH-111", language: "en", examFormat: { kind: "exercises", durationMin: 90 } }, "owner");
  await insertCourse(en);
  await reloadCourses();
  courseFr = fr.id;
  courseEn = en.id;
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Ce que rend le générateur d'exercices : durée par défaut du cours, deux questions de 45 points. */
const SPEC = {
  title: "TEST-E2E Calcul matriciel — Final Exam",
  duration_min: 180,
  questions: [
    { category: "General", concept: "Gradient d'une forme quadratique", points: 45, statement_tex: String.raw`\subq{1.1}{Calcul}{20} Soit $A$.\rulelines{4}\subq{1.2}{Preuve}{25} Montrez.`, solution_tex: String.raw`\subq{1.1}{Calcul}{20} $\nabla f = 2Ax$.` },
    {
      category: "General", concept: "Dérivée du neurone ReLU", points: 45,
      statement_tex: String.raw`\callout{This question is \textbf{\large FOR ALL STUDENTS.}}\subq{1.1}{Dérivée}{10} Calculez $\mathbb{1}[z>0]$.\subq{1.2}{Chaîne}{35} Puis 𝟙[z>0] et $\mathbbm{1}_{z>0}$.`,
      solution_tex: String.raw`\subq{1.1}{Dérivée}{10} $\sigma'(z) = \mathbb{1}[z>0]$.\subq{1.2}{Chaîne}{35} Ok.`,
    },
  ],
};

async function render(course: string): Promise<string> {
  const { runWithCourse } = await import("../db/client");
  const { renderExamTex } = await import("../lib/exam-latex");
  return runWithCourse(course, async () => renderExamTex(SPEC as never, "2026-11-13", true));
}

test("la garde suit le format déclaré du cours : durée, documents et langue", async () => {
  const tex = await render(courseFr);
  assert.match(tex, /Vous disposez de 60 minutes/);
  assert.match(tex, /Aucun document n'est autorisé/);
  assert.match(tex, /CONSIGNES/);
  assert.match(tex, /2 exercices indépendants/);
  assert.match(tex, /13 novembre 2026/);
  for (const en of [/You have/, /Personal notes/, /closed book/, /INSTRUCTIONS \(please/, /LEAVE THIS EMPTY/, /November/]) assert.doesNotMatch(tex, en);
});

test("sans règle déclarée sur les documents, la garde n'en invente pas ; la langue du cours décide", async () => {
  const tex = await render(courseEn);
  assert.match(tex, /You have 90 minutes/);
  assert.doesNotMatch(tex, /Personal notes|closed book|No documents/);
});

test("l'encadré « FOR ALL STUDENTS » de CS-202 n'est ni demandé au modèle ni rendu ailleurs", async () => {
  // Le préambule partagé cite l'encadré en commentaire : seul le document compte.
  const tex = await render(courseFr);
  const doc = tex.slice(tex.indexOf("\n" + String.raw`\begin{document}` + "\n"));
  assert.doesNotMatch(doc, /FOR ALL STUDENTS/);
  const { runWithCourse } = await import("../db/client");
  const { profile } = await import("../lib/course-profile");
  const contract = await runWithCourse(courseFr, async () => profile().latexContract());
  assert.doesNotMatch(contract, /FOR ALL STUDENTS|\\callout/);
});

test("les sous-questions portent le numéro de leur question, énoncé et corrigé", async () => {
  const tex = await render(courseFr);
  const doc = tex.slice(tex.indexOf("\n" + String.raw`\begin{document}` + "\n"));
  const q2 = doc.slice(doc.indexOf(String.raw`\examq{2}`), doc.indexOf("Corrigé"));
  assert.deepEqual([...q2.matchAll(/\\subq\{([\d.]+)\}/g)].map((m) => m[1]), ["2.1", "2.2"]);
  const sol2 = doc.slice(doc.indexOf("Question 2 —"));
  assert.deepEqual([...sol2.matchAll(/\\subq\{([\d.]+)\}/g)].map((m) => m[1]), ["2.1", "2.2"]);
  const q1 = doc.slice(doc.indexOf(String.raw`\examq{1}`), doc.indexOf(String.raw`\examq{2}`));
  assert.deepEqual([...q1.matchAll(/\\subq\{([\d.]+)\}/g)].map((m) => m[1]), ["1.1", "1.2"]);
});

test("l'indicatrice 𝟙 sort d'une macro définie au préambule, jamais de \\mathbb{1} (glyphe cassé)", async () => {
  const tex = await render(courseFr);
  const at = tex.indexOf("\n" + String.raw`\begin{document}` + "\n");
  const [head, doc] = [tex.slice(0, at), tex.slice(at)];
  assert.match(head, /\\providecommand\{\\indic\}/);
  assert.doesNotMatch(doc, /\\mathbb\s*\{?\s*1|\\mathbbm|𝟙/u);
  assert.equal([...doc.matchAll(/\\indic\b/g)].length, 4, "énoncé (3) et corrigé (1)");
});
