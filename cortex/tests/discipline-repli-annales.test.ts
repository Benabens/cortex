/**
 * DISCIPLINE QUAND NI LE CODE, NI LE NOM, NI LE CORPUS NE TRANCHENT (audit « formats » du 16/11,
 * a1-P1-10 / a3-P1-8, reste de #166). Sans supports de cours (moins de 300 caractères), la discipline
 * retombait sur « stem » même quand les annales, déjà ingérées, sont de la pure prose : l'étudiant
 * recevait des problèmes à calculs. Les annales sont un signal du même ordre que le corpus (leur
 * densité de notation mathématique) ; sans elles non plus, le comportement historique reste.
 * Cours et annales fictifs, aucun appel LLM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-discipline-repli-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "MAX_COURSES_CREATED_PER_HOUR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Annale de lettres telle que l'extraction la rend : en-tête, dates, pages et barèmes (des chiffres
// séparés par « - » ou « / », que la mesure ne doit pas prendre pour des calculs).
const PROSE_EXAM = "Final exam 2023-2024, session of 16/01/2024. Page 1/4. Question 1 (8/20). Discuss how the reformers of the period understood the relation between the town and the countryside, drawing on two authors studied this term. Question 2 (12/20). To what extent did the new institutions change everyday life? Support your answer with precise examples. ".repeat(4);
const MATHS_EXAM = "Final exam 2024. Problem 1. Let f(x) = x^2 + 3x - 1. Compute f'(2) = 7 and ∫ f(x) dx from 0 to 1 = 1/3 + 3/2 - 1. Problem 2. Solve 2x + 5 = 3(x - 1) and show that x = 8. ".repeat(6);
// Annale de maths dont les formules sont restées dans les images : que des mots.
const MATHS_IN_WORDS = "Final exam 2024. Problem 1. Let the function be defined on the closed interval as shown in the figure. Show that it is continuous, then compute its derivative at the point indicated and deduce the tangent line. Problem 2. Prove that the sequence defined in the figure converges and find its limit. ".repeat(4);

/** Un cours au code et au nom neutres, sans support de cours, avec une annale. */
async function courseWithAnnale(code: string, annale: string, types: string[] = []) {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const row = buildCourseRow({ name: "Seminar", code, language: "en" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Final 2024", "final/2024", 2024, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exercise", "Final 2024", annale);
    // Types de questions relevés dans l'annale par la détection du format.
    if (types.length) {
      await q.ensureTable("format_profile");
      await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({
        format_summary: "Two problems", duration_min: 120, total_points: 40, has_mcq: false, scq_vs_mcq_convention: "",
        question_types: types.map((type) => ({ type, approx_count: 2, share_pct: Math.round(100 / types.length), points_each: 20, note: "" })), sections: [], topics_emphasis: [],
      }));
    }
  });
  return row.id;
}

async function discipline(id: string) {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  return runWithCourse(id, async () => (await resolveExamFormat()).discipline);
}

test("sans supports de cours, une annale en prose (dates, pages, barèmes compris) donne les sciences humaines", async () => {
  assert.equal(await discipline(await courseWithAnnale("XYZ 101", PROSE_EXAM)), "humanities");
});

test("sans supports de cours, une annale pleine de formules reste en STEM", async () => {
  assert.equal(await discipline(await courseWithAnnale("XYZ 102", MATHS_EXAM)), "stem");
});

test("des calculs ou des preuves relevés dans l'annale gardent le STEM, même sans formules lisibles", async () => {
  assert.equal(await discipline(await courseWithAnnale("XYZ 103", MATHS_IN_WORDS, ["calc", "proof"])), "stem");
});

test("ni code, ni nom, ni corpus, ni annale assez longue : le comportement historique (STEM)", async () => {
  const { inferDiscipline } = await import("../lib/exam-format");
  assert.equal(inferDiscipline({ code: "", name: "Seminar", sample: "", annales: "" }), "stem");
  assert.equal(inferDiscipline({ code: "", name: "Seminar", sample: "", annales: PROSE_EXAM.slice(0, 600) }), "stem", "annale trop courte");
  // Les supports, quand ils suffisent, passent avant les annales.
  assert.equal(inferDiscipline({ code: "", name: "Seminar", sample: MATHS_EXAM, annales: PROSE_EXAM }), "stem");
  // Des supports trop courts s'ajoutent aux annales.
  assert.equal(inferDiscipline({ code: "", name: "Seminar", sample: "Lecture 1: the reform movements.", annales: PROSE_EXAM }), "humanities");
});
