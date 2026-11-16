/**
 * GABARIT EPFL BYTE-IDENTIQUE. Le gabarit neutre (cours hors EPFL) ne doit rien changer au rendu
 * d'un cours dont l'établissement est l'EPFL : empreintes sha256 capturées sur main (d9f42f2, 16/11/2026)
 * AVANT l'introduction du gabarit neutre, sur un cours EPFL FICTIF (tests/helpers/gabarits.ts).
 * Le rendu de cs-202 garde sa propre empreinte canonique (tests/tex-guard.test.ts, CI).
 *
 * Recapturées le 16/11/2026 (langue des examens, tests/gabarit-epfl-langue) : seuls changent, pour
 * ce cours anglais, le type d'examen (« Examen final » → « Final Exam »), « Anonymisation: » sans
 * l'espace française, la consigne inventée « cheat sheet / no electronic device » (retirée),
 * « idée fausse : » / « Solution : » (→ « misconception: » / « Solution: ») et les titres du corrigé
 * (« Corrigé » → « Solutions », « Question 1 : » → « Question 1 -- »). Mise en page inchangée.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gabarit-epfl-"));
process.env.CORTEX_DATA_DIR = tmp;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
let epfl = "";

before(async () => {
  const { createGabaritCourses } = await import("./helpers/gabarits");
  epfl = (await createGabaritCourses()).epfl;
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function inEpfl<T>(fn: () => T | Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(epfl, async () => fn());
}

test("examen écrit d'un cours EPFL : .tex inchangé, énoncé et corrigé", async () => {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  assert.equal(sha(await inEpfl(() => renderExamTex(WRITTEN_SPEC as never, DATE, true))), "98d28d137dd0bfae");
  assert.equal(sha(await inEpfl(() => renderExamTex(WRITTEN_SPEC as never, DATE, false))), "f2b9112e44ffccba");
});

test("QCM d'un cours EPFL : .tex inchangé, énoncé et corrigé", async () => {
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { QCM_DATA, DATE } = await import("./helpers/gabarits");
  // Finition v7 (examen #16), changements voulus : la durée du cours (120) au lieu des 180 minutes
  // inventées faute de durée détectée, et chaque note « idée fausse » du corrigé sous son option ;
  // puis les libellés de l'audit i18n (cf. l'en-tête de ce fichier).
  assert.equal(sha(await inEpfl(() => renderQcmExamTex(QCM_DATA, DATE, false))), "e6d6d58c6a34121a");
  assert.equal(sha(await inEpfl(() => renderQcmExamTex(QCM_DATA, DATE, true))), "1697eb665f7dbc1f");
});

test("questions composées d'un cours EPFL : .tex inchangé, énoncé et corrigé", async () => {
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const { BLOCKS, DATE } = await import("./helpers/gabarits");
  assert.equal(sha(await inEpfl(() => renderBlocksTex(BLOCKS, DATE, false))), "5bb4b8f7ef8300ef");
  assert.equal(sha(await inEpfl(() => renderBlocksTex(BLOCKS, DATE, true))), "a43650362d95305a");
});

test("repli HTML d'un cours EPFL : inchangé", async () => {
  const { htmlFallback } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  assert.equal(sha(await inEpfl(() => htmlFallback(WRITTEN_SPEC as never, 1, DATE, "boom"))), "787640f4f8b6f6f7");
});

test("cs-202 garde le gabarit de l'EPFL même si son établissement n'est pas renseigné en base", async () => {
  const { examTemplate } = await import("../lib/exam-template");
  assert.equal(examTemplate({ id: "cs-202", university: "" }), "epfl");
  assert.equal(examTemplate({ id: "fic-101", university: " epfl " }), "epfl");
  assert.equal(examTemplate({ id: "img-210", university: "Testville University" }), "neutral");
});
