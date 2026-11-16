/**
 * GABARIT NEUTRE : un examen d'un cours hors EPFL ne porte aucune marque de l'EPFL (logo en garde
 * ou en pied de page, SCIPER, « Anonymisation », marge « Do NOT write anything here! », rouge des
 * corrigés, consignes propres à l'EPFL). Garde générique : cours, durée, total des points, champs
 * Nom / Identifiant, le tout dans la langue de l'examen. Cours et examens FICTIFS
 * (tests/helpers/gabarits.ts) ; le gabarit EPFL est verrouillé par gabarit-epfl-non-regression.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { GabaritCourses } from "./helpers/gabarits";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gabarit-neutre-"));
process.env.CORTEX_DATA_DIR = tmp;

let ids: GabaritCourses;

before(async () => {
  const { createGabaritCourses } = await import("./helpers/gabarits");
  ids = await createGabaritCourses();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function inCourse<T>(course: string, fn: () => T | Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(course, async () => fn());
}

/** Ce que l'étudiant voit : le corps du document (le préambule cite `\begin{document}` en commentaire). */
function body(tex: string): string {
  return tex.slice(tex.lastIndexOf(String.raw`\begin{document}`));
}

const RESET = String.raw`\pagestyle{fancy}\fancyhf{}`;

/**
 * En-têtes et pieds en vigueur : `\pagestyle{fancy}\fancyhf{}` efface tout, donc seules comptent
 * les définitions qui suivent le dernier, jusqu'au début du document.
 */
function pageChrome(tex: string): string {
  return tex.slice(tex.lastIndexOf(RESET), tex.lastIndexOf(String.raw`\begin{document}`));
}

const EPFL_MARKS = /epfl|SCIPER|Anonymi|Hanon Ymous|Do NOT write|cheat sheet|dark blue ink|qrcode/i;
/** Les deux lignes qui neutralisent le logo et le rouge (une macro du modèle qui les citerait compile encore). */
const NEUTRALIZED = [String.raw`\renewcommand{\epfllogo}[1][30]{}`, String.raw`\colorlet{epflred}{solution}`];

/** Aucune marque EPFL, ni sur les pages ni dans leur en-tête et pied ; marge et logo neutralisés. */
function assertNeutral(tex: string): void {
  assert.doesNotMatch(body(tex), EPFL_MARKS);
  assert.ok(tex.lastIndexOf(RESET) > tex.indexOf(String.raw`\fancyfoot[L]{\epfllogo[15]}`), "en-tête et pied du préambule EPFL encore en vigueur");
  const chrome = pageChrome(tex);
  for (const line of NEUTRALIZED) assert.ok(chrome.includes(line), `manque : ${line}`);
  assert.doesNotMatch(NEUTRALIZED.reduce((c, line) => c.replace(line, ""), chrome), EPFL_MARKS);
  assert.match(chrome, /\\examchromefalse/, "marge « Do NOT write anything here! » encore active");
}

test("examen écrit hors EPFL : garde neutre en anglais, sans aucune marque EPFL", async () => {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  for (const withSol of [false, true]) {
    const tex = await inCourse(ids.neutralEn, () => renderExamTex(WRITTEN_SPEC as never, DATE, withSol));
    assertNeutral(tex);
    const page = body(tex);
    assert.match(page, /IMG--210/);
    assert.match(page, /Imaginary Networks/);
    assert.match(page, /Testville University/);
    assert.match(page, /November 16, 2026/);
    assert.match(page, /Duration:\}? 90 minutes/);
    assert.match(page, /Total:\}? 50 points/);
    assert.match(page, /Name:/);
    assert.match(page, /ID:/);
  }
});

test("examen écrit hors EPFL : garde neutre dans la langue de l'examen (français)", async () => {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  const tex = await inCourse(ids.neutralFr, () => renderExamTex(WRITTEN_SPEC as never, DATE, true));
  assertNeutral(tex);
  const page = body(tex);
  assert.match(page, /Durée :\}? 60 minutes/);
  assert.match(page, /Total :\}? 50 points/);
  assert.match(page, /Nom :/);
  assert.match(page, /16 novembre 2026/);
  assert.match(page, /Aucun document n'est autorisé/);
  for (const en of [/Duration/, /Name:/, /November/, /INSTRUCTIONS/]) assert.doesNotMatch(page, en);
});
