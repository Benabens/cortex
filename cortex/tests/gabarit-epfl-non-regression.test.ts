/**
 * GABARIT EPFL BYTE-IDENTIQUE. Le gabarit neutre (cours hors EPFL) ne doit rien changer au rendu
 * d'un cours dont l'établissement est l'EPFL : empreintes sha256 capturées sur main (d9f42f2, 16/11/2026)
 * AVANT l'introduction du gabarit neutre, sur un cours EPFL FICTIF (tests/helpers/gabarits.ts).
 * Le rendu de cs-202 garde sa propre empreinte canonique (tests/tex-guard.test.ts, CI).
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
  assert.equal(sha(await inEpfl(() => renderExamTex(WRITTEN_SPEC as never, DATE, true))), "ef69e3ef04bdd2d1");
  assert.equal(sha(await inEpfl(() => renderExamTex(WRITTEN_SPEC as never, DATE, false))), "ab6b227c1ce13a0d");
});

test("QCM d'un cours EPFL : .tex inchangé, énoncé et corrigé", async () => {
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { QCM_DATA, DATE } = await import("./helpers/gabarits");
  // Finition v7 (examen #16), changements voulus : la durée du cours (120) au lieu des 180 minutes
  // inventées faute de durée détectée, et chaque note « idée fausse » du corrigé sous son option.
  assert.equal(sha(await inEpfl(() => renderQcmExamTex(QCM_DATA, DATE, false))), "bfcf8616dc77ec5a");
  assert.equal(sha(await inEpfl(() => renderQcmExamTex(QCM_DATA, DATE, true))), "767f8f977dd51766");
});

test("questions composées d'un cours EPFL : .tex inchangé, énoncé et corrigé", async () => {
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const { BLOCKS, DATE } = await import("./helpers/gabarits");
  assert.equal(sha(await inEpfl(() => renderBlocksTex(BLOCKS, DATE, false))), "325f95d49737f51b");
  assert.equal(sha(await inEpfl(() => renderBlocksTex(BLOCKS, DATE, true))), "78db72e73ff1e0f0");
});

test("repli HTML d'un cours EPFL : inchangé", async () => {
  const { htmlFallback } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  assert.equal(sha(await inEpfl(() => htmlFallback(WRITTEN_SPEC as never, 1, DATE, "boom"))), "a251243848b08a75");
});

test("cs-202 garde le gabarit de l'EPFL même si son établissement n'est pas renseigné en base", async () => {
  const { examTemplate } = await import("../lib/exam-template");
  assert.equal(examTemplate({ id: "cs-202", university: "" }), "epfl");
  assert.equal(examTemplate({ id: "fic-101", university: " epfl " }), "epfl");
  assert.equal(examTemplate({ id: "img-210", university: "Testville University" }), "neutral");
});
