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

test("PDF recompilé dans un processus neuf : le format est résolu avant, le partiel reste un partiel", async (t) => {
  const { execFileSync } = await import("node:child_process");
  if (!["tectonic", "pdflatex"].some((b) => { try { execFileSync("which", [b], { stdio: "ignore" }); return true; } catch { return false; } })) return t.skip("tectonic/pdflatex absent");
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { getQcmExam, recompileQcmPdf } = await import("../lib/qcm");
  const { examsDir } = await import("../lib/paths");
  // Cours jamais résolu dans ce processus (mémoire du format vide), annales toutes partielles : la
  // recompilation d'un PDF (app/api/exams/[id]/pdf) ne passe pas par la génération.
  const row = buildCourseRow({ name: "Cold Fictional Course", code: "CLD-110", university: "Testville University", language: "en", examFormat: { kind: "qcm", durationMin: 50 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const tex = await runWithCourse(row.id, async () => {
    for (const tbl of ["sources", "items"]) await q.ensureTable(tbl);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "midterm", "midterm 2025", "refs/midterm-2025.pdf", 2025, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exam", "midterm 2025", "Question 1. Pick the fictional answer.");
    // Questions composées d'abord (mémoire encore vide) : leur rendu résout le format (par la durée) avant la garde.
    const { renderBlocksTex } = await import("../lib/blocks-latex");
    const { BLOCKS, DATE } = await import("./helpers/gabarits");
    const blocks = await renderBlocksTex(BLOCKS, DATE, false);
    const { formatContextFor } = await import("../lib/exam-format");
    assert.equal(formatContextFor(row.id).genre, "midterm");
    await getQcmExam(0);
    const id = await q.insert(`INSERT INTO exams (format_template, status, html_path) VALUES ('qcm','ready','')`);
    await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, 0, "Fiction", "scq", "Which answer is fictional?", JSON.stringify(["This one", "That one"]), "[0]", "[]", "This one is fictional.", 1);
    await recompileQcmPdf(id);
    return [blocks, fs.readFileSync(path.join(examsDir(), `qcm-${id}.tex`), "utf8")];
  });
  for (const x of tex) assert.match(x, /Midterm exam/);
});
