/**
 * DURÉE D'UNE ÉPREUVE — celle du format du cours ou de l'annale, jamais 180 minutes par défaut
 * (audit 3, P1-3 et P1-4 ; audit 5, #9 — 16/11/2026). Un QCM déclaré de 75 min affichait
 * « Duration: 180 minutes », une annale sans durée lisible « 0 minutes », une épreuve à questions
 * composées de 50 min la durée cachée du cours. Une durée inconnue n'est pas écrite.
 * Cours fictifs, aucun appel au modèle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-duree-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
async function newCourse(over: Record<string, unknown>): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: `Fictional Course ${++seq}`, code: `FIC ${100 + seq}`, university: "Fictional University", language: "en", ...over }, "owner");
  await insertCourse(row);
  await reloadCourses();
  return row.id;
}

const ITEM = {
  topic: "Sorting", type: "scq" as const, stem: "Which sort is stable?", options: ["Merge sort", "Heap sort", "Quick sort", "Selection sort"], correct: [0],
  misconceptions: ["", "a", "b", "c"], explanation: "Merge sort keeps equal keys in order.", verified: 1 as const,
};

async function qcmTex(course: string): Promise<string> {
  const { runWithCourse } = await import("../db/client");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  return runWithCourse(course, () => renderQcmExamTex({ items: [ITEM], open: [] } as never, "2026-11-16", false));
}

test("QCM déclaré de 75 min : la garde dit 75 minutes, jamais 180", async () => {
  const tex = await qcmTex(await newCourse({ examFormat: { kind: "qcm", questionCount: 10, durationMin: 75 } }));
  // Garde neutre de main (#116) : la durée est écrite une fois, dans l'en-tête.
  assert.match(tex, /\\textbf\{Duration:\} 75 minutes/);
  assert.equal(tex.match(/75 minutes/g)?.length, 1, "durée écrite une seule fois");
  assert.doesNotMatch(tex, /\b180 minutes/);
});

test("QCM sans durée connue : aucune durée n'est écrite (ni 180, ni 0)", async () => {
  const tex = await qcmTex(await newCourse({ examFormat: { kind: "qcm", questionCount: 10 } }));
  assert.doesNotMatch(tex, /Duration:|You have \d|\b180 minutes|\b0 minutes/);
});

test("annale sans durée lisible (0) : la durée déclarée du cours l'emporte sur l'inconnu", async () => {
  const id = await newCourse({ examFormat: { kind: "qcm", durationMin: 50 } });
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { resolveExamFormat } = await import("../lib/exam-format");
  await runWithCourse(id, async () => {
    for (const t of ["sources", "items", "format_profile"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Final 2025", "final/2025", 2025, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exercise", "Final 2025", "Final exam. Choose the one correct answer for each question below.");
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({ format_summary: "10 single-answer questions", duration_min: 0, total_points: 10, has_mcq: true, scq_vs_mcq_convention: "", question_types: [{ type: "scq", approx_count: 10, share_pct: 100 }], sections: [], topics_emphasis: [] }));
  });
  const f = await runWithCourse(id, () => resolveExamFormat());
  assert.equal(f.basis, "annales");
  assert.equal(f.durationMin, 50);
  const tex = await qcmTex(id);
  assert.match(tex, /\\textbf\{Duration:\} 50 minutes/);
});

test("questions composées déclarées de 50 min : la garde dit 50 minutes", async () => {
  const id = await newCourse({ examFormat: { kind: "composite", questionCount: 3, durationMin: 50 } });
  const { runWithCourse } = await import("../db/client");
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const tex = await runWithCourse(id, () => renderBlocksTex([], "2026-11-16", false));
  assert.match(tex, /\\textbf\{Duration:\} 50 minutes/);
  assert.equal(tex.match(/50 minutes/g)?.length, 1, "durée écrite une seule fois");
  assert.doesNotMatch(tex, /\b180 minutes|\b90 minutes/);
});

test("exercices sans durée connue : la garde n'écrit pas les 180 minutes de la spec du générateur", async () => {
  const id = await newCourse({ examFormat: { kind: "exercises", questionCount: 1 } });
  const { runWithCourse } = await import("../db/client");
  const { renderExamTex } = await import("../lib/exam-latex");
  const spec = { title: "FIC Final", duration_min: 180, questions: [{ category: "General", concept: "Sorting", points: 10, statement_tex: "Sort the list.", solution_tex: "Merge sort." }] };
  const tex = await runWithCourse(id, () => renderExamTex(spec as never, "2026-11-16", false));
  assert.doesNotMatch(tex, /You have|3 hours|180 minutes/);
});

test("un cours créé sans durée n'en reçoit pas une cachée de 180 minutes", async () => {
  const { getCourse } = await import("../lib/courses");
  assert.equal(getCourse(await newCourse({})).durationMin, null);
});

test("durée déclarée et durée d'annale : la déclaration (l'épreuve de cette année) l'emporte", async () => {
  const id = await newCourse({ examFormat: { kind: "qcm", durationMin: 75 } });
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { resolveExamFormat } = await import("../lib/exam-format");
  await runWithCourse(id, async () => {
    for (const t of ["sources", "items", "format_profile"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Final 2024", "final/2024", 2024, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exercise", "Final 2024", "Final exam. Choose the one correct answer for each question below.");
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({ format_summary: "10 single-answer questions", duration_min: 120, total_points: 10, has_mcq: true, scq_vs_mcq_convention: "", question_types: [{ type: "scq", approx_count: 10, share_pct: 100 }], sections: [], topics_emphasis: [] }));
  });
  assert.equal((await runWithCourse(id, () => resolveExamFormat())).durationMin, 75);
});
