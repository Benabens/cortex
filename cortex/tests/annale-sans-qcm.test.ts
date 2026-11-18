/**
 * FORME D'UNE ANNALE SANS QCM (audit du 16/11/2026, axe 3 P1-6 et P1-7). Le chemin sans QCM de
 * `fromAnnalesProfile` ne lisait pas les types de questions détectés : une annale à 6 problèmes
 * donnait un plan sans nombre (le profil générique en sortait 4), et une annale de 2 dissertations
 * sortait en « problems » à sous-questions et nombres non ronds. Cours et annales fictifs, aucun appel LLM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-annale-sans-qcm-"));
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

const FINAL = "Final exam. Answer all the questions. Justify every step of your answers and write clearly on the sheet provided.";
type QType = { type: string; approx_count: number; share_pct: number; points_each?: number };

let n = 0;
async function courseWithAnnale(code: string, summary: string, types: QType[]) {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const row = buildCourseRow({ name: `Course ${++n}`, code, language: "en" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    for (const t of ["sources", "items", "format_profile"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Final 2024", "final/2024", 2024, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exercise", "Final 2024", FINAL);
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({
      format_summary: summary, duration_min: 120, total_points: 100, has_mcq: false, scq_vs_mcq_convention: "",
      question_types: types, sections: [], topics_emphasis: [],
    }));
  });
  return row.id;
}

async function plan(id: string) {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat, planMockExam } = await import("../lib/exam-format");
  return runWithCourse(id, async () => planMockExam(await resolveExamFormat(), {}));
}

test("annale à 6 problèmes : le plan en demande 6", async () => {
  const id = await courseWithAnnale("STA 101", "Six independent problems", [{ type: "calc", approx_count: 6, share_pct: 100, points_each: 15 }]);
  assert.deepEqual(await plan(id), { generator: "exercises", style: "problems", exerciseCount: 6 });
});

test("annale mêlant calcul et preuve : les deux comptent", async () => {
  const id = await courseWithAnnale("MATH 250", "Four computations and two proofs", [{ type: "calc", approx_count: 4, share_pct: 60 }, { type: "proof", approx_count: 2, share_pct: 40 }]);
  assert.deepEqual(await plan(id), { generator: "exercises", style: "problems", exerciseCount: 6 });
});

test("annale de 2 dissertations d'un cours de lettres : essai, 2 sujets", async () => {
  const id = await courseWithAnnale("ENGL 101", "Two essay questions", [{ type: "open", approx_count: 2, share_pct: 100 }]);
  assert.deepEqual(await plan(id), { generator: "exercises", style: "essay", exerciseCount: 2 });
});

test("questions ouvertes d'un cours scientifique : des problèmes, pas un essai", async () => {
  const id = await courseWithAnnale("PHYS 101", "Three open questions with derivations", [{ type: "open", approx_count: 3, share_pct: 100 }]);
  assert.deepEqual(await plan(id), { generator: "exercises", style: "problems", exerciseCount: 3 });
});

test("annale dont les types sont inconnus : le comportement d'avant (nombre laissé au profil)", async () => {
  const id = await courseWithAnnale("STA 102", "", []);
  assert.deepEqual(await plan(id), { generator: "exercises", style: "problems", exerciseCount: null });
});
