/**
 * EXAMLAYOUT : la mise en page d'un examen (garde, en-tête et pied, libellés) est une donnée,
 * lue une fois par les trois moteurs de rendu (écrit, QCM, questions composées). Défaut neutre,
 * variante EPFL explicite. Cours et examens FICTIFS (tests/helpers/gabarits.ts).
 *
 * Les empreintes du gabarit neutre ont été capturées sur main (a0dc606, 17/11/2026) avant
 * l'introduction du module : sans mise en page relevée, rien ne change. Celles de l'EPFL sont
 * dans gabarit-epfl-non-regression, celle de cs-202 dans tex-guard.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { GabaritCourses } from "./helpers/gabarits";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-layout-"));
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

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

async function inCourse<T>(course: string, fn: () => T | Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(course, async () => fn());
}

/** Les trois formes d'examen, énoncé puis corrigé, rendues dans le cours `course`. */
async function renders(course: string): Promise<string[]> {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const { WRITTEN_SPEC, QCM_DATA, BLOCKS, DATE } = await import("./helpers/gabarits");
  return inCourse(course, async () => [
    await renderExamTex(WRITTEN_SPEC as never, DATE, false),
    await renderExamTex(WRITTEN_SPEC as never, DATE, true),
    await renderQcmExamTex(QCM_DATA, DATE, false),
    await renderQcmExamTex(QCM_DATA, DATE, true),
    await renderBlocksTex(BLOCKS, DATE, false),
    await renderBlocksTex(BLOCKS, DATE, true),
  ]);
}

/**
 * Seul changement voulu depuis #116 : le titre de partie des QCM, « Part 1 -- … » au lieu de
 * « Part 1 \quad-- … » (espace en trop). Remis à l'ancienne, les .tex retrouvent leurs empreintes d'avant.
 */
const beforePartFix = (tex: string) => tex.replace(/(\S+ [12]) -- /g, String.raw`$1 \quad-- `);

test("gabarit neutre sans mise en page relevée : .tex inchangés (anglais)", async () => {
  const tex = await renders(ids.neutralEn);
  assert.deepEqual(tex.map(sha), [
    "c2ac315e925f5e13", "c0d1a895d9f5d995", "d0836e1917f9710b", "eee73c9711b45ed0", "4f0fd87e16a2c553", "9572e53640d5202d",
  ]);
  assert.deepEqual(tex.map(beforePartFix).map(sha).slice(2, 4), ["0acf19cd2a88cf9b", "f827be5064180cb2"]);
});

test("gabarit neutre sans mise en page relevée : .tex inchangés (français)", async () => {
  const tex = await renders(ids.neutralFr);
  assert.deepEqual(tex.map(sha), [
    "f644538b622efba4", "c0a66c94191855a4", "fd5c4fb497c5ce50", "1371d4da41bc675b", "49695dd5549cfe2d", "bd4415ba0161f212",
  ]);
  assert.deepEqual(tex.map(beforePartFix).map(sha).slice(2, 4), ["1fe88c95b586f296", "afc72736584f0e94"]);
});

test("la mise en page du cours : EPFL explicite pour un cours de l'EPFL, neutre sinon", async () => {
  const { examLayout } = await import("../lib/exam-layout");
  assert.equal((await inCourse(ids.epfl, () => examLayout())).source, "epfl");
  assert.equal((await inCourse("cs-202", () => examLayout())).source, "epfl");
  assert.equal((await inCourse(ids.neutralEn, () => examLayout())).source, "neutral");
});

/** Ce que l'étudiant voit : le corps du document (le préambule cite `\begin{document}` en commentaire). */
const body = (tex: string) => tex.slice(tex.lastIndexOf(String.raw`\begin{document}`));
/** Les marques de la mise en page de l'EPFL ; le nom de l'établissement, lui, reste sur la garde. */
const EPFL_MARKS = /\\epfllogo|SCIPER|Anonymi|Hanon Ymous|Do NOT write|qrcode|epflred/i;

test("les trois moteurs ne lisent que la mise en page : un cours de l'EPFL rendu en neutre ne porte aucune marque de l'EPFL", async () => {
  const { NEUTRAL_LAYOUT } = await import("../lib/exam-layout");
  const { renderExamTex } = await import("../lib/exam-latex");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const { WRITTEN_SPEC, QCM_DATA, BLOCKS, DATE } = await import("./helpers/gabarits");
  const texs = await inCourse(ids.epfl, async () => [
    await renderExamTex(WRITTEN_SPEC as never, DATE, true, NEUTRAL_LAYOUT),
    await renderQcmExamTex(QCM_DATA, DATE, true, NEUTRAL_LAYOUT),
    await renderBlocksTex(BLOCKS, DATE, true, NEUTRAL_LAYOUT),
  ]);
  for (const tex of texs) {
    assert.doesNotMatch(body(tex), EPFL_MARKS);
    assert.match(tex, /\\examchromefalse/, "marge « Do NOT write anything here! » encore active");
  }
});
