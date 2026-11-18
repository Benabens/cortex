/**
 * GENRE DE L'EXAMEN (audit du 16/11/2026, axe 1 P1-8 et axe 3 P1-5) : tout cours créé porte le type
 * « Examen final » par défaut. Le rendu le traduisait (#116) mais un cours dont les annales sont
 * des partiels imprimait encore « Final exam » en garde et en pied, et le titre de l'examen gardait
 * « Examen final » en français pour un cours anglais. Cours et annales FICTIFS.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { GabaritCourses } from "./helpers/gabarits";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-genre-examen-"));
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

/** Annales fictives du cours, puis format résolu (comme avant une génération). */
async function withAnnales<T>(course: string, kinds: string[], fn: () => T | Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { resolveExamFormat } = await import("../lib/exam-format");
  return runWithCourse(course, async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    await q.run(`DELETE FROM items`);
    await q.run(`DELETE FROM sources`);
    for (const [i, type] of kinds.entries()) {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, `${type} ${2020 + i}`, `refs/${type}-${2020 + i}.pdf`, 2020 + i, 1);
      await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exam", `${type} ${2020 + i}`, "Exercise 1. Compute the fictional quantity.");
    }
    await resolveExamFormat();
    return fn();
  });
}

const examTex = async () => {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  return renderExamTex(WRITTEN_SPEC as never, DATE, false);
};

test("annales toutes partielles : la garde dit « Midterm exam », en anglais comme en français", async () => {
  const en = await withAnnales(ids.neutralEn, ["midterm", "midterm"], examTex);
  assert.match(en, /Midterm exam/);
  assert.doesNotMatch(en, /Final exam/);
  const fr = await withAnnales(ids.neutralFr, ["midterm"], examTex);
  assert.match(fr, /Examen partiel/);
  assert.doesNotMatch(fr, /Examen final/);
});

test("un final parmi les annales, ou aucune annale : l'examen reste un final", async () => {
  assert.match(await withAnnales(ids.neutralEn, ["midterm", "final"], examTex), /Final exam/);
  assert.match(await withAnnales(ids.neutralEn, [], examTex), /Final exam/);
});

test("gabarit EPFL hors CS-202 : le pied et la garde suivent aussi le genre des annales", async () => {
  const tex = await withAnnales(ids.epfl, ["midterm"], examTex);
  assert.match(tex, /FIC--101, Midterm Exam/);
  assert.doesNotMatch(tex, /FIC--101, Final Exam|\\textbf{Final Exam}/);
});

test("titre de l'examen : le type dans la langue de l'examen, plus « Examen final » en dur", async () => {
  const { examKindLabel } = await import("../lib/exam-template");
  const { getCourse } = await import("../lib/courses");
  assert.equal(await withAnnales(ids.neutralEn, [], () => examKindLabel(getCourse(ids.neutralEn))), "Final exam");
  assert.equal(await withAnnales(ids.neutralEn, ["midterm"], () => examKindLabel(getCourse(ids.neutralEn))), "Midterm exam");
  assert.equal(await withAnnales(ids.neutralFr, [], () => examKindLabel(getCourse(ids.neutralFr))), "Examen final");
});
