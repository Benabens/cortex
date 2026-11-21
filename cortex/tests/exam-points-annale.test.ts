/**
 * BARÈME PAR EXERCICE (audit « formats » du 16/11, a3-P1-6) : l'examen blanc reprend le barème de
 * l'annale exercice par exercice quand elle le donne ; sinon le total de l'examen se partage selon
 * les poids des sujets, sans jamais le dépasser quand on demande plus d'exercices que le blueprint.
 * Lots déterministes (CORTEX_TEST_STUB_BATCH) : chaque exercice porte les points de son slot, lus
 * dans les \examq{n}{titre}{points} du .tex produit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-points-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.CORTEX_TEST_STUB_BATCH = "1";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "CORTEX_TEST_STUB_BATCH", "MAX_COURSES_CREATED_PER_HOUR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Les points de chaque exercice d'un examen généré, triés (le rendu ordonne par catégorie). */
async function examPoints(course: string, count: number): Promise<number[]> {
  const { runWithCourse } = await import("../db/client");
  const { generateExamViaClaudeCode } = await import("../lib/exam");
  const { examsDir } = await import("../lib/paths");
  return runWithCourse(course, async () => {
    const r = await generateExamViaClaudeCode({ count, verify: false });
    // L'adresse de l'examen nomme son PDF ; le .tex est à côté.
    const file = decodeURIComponent(r.url.replace(/^\/exam\//, "").replace(/\?.*$/, ""));
    const tex = path.join(examsDir(), file.replace(/\.[a-z]+$/, ".tex"));
    assert.ok(fs.existsSync(tex), `${tex} introuvable`);
    const body = fs.readFileSync(tex, "utf8").split(/^\\begin\{document\}/m)[1];
    return [...body.matchAll(/\\examq\{\d+\}\{[^}]*\}\{(\d+)\}/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  });
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

test("sans annale, le nombre demandé ne change pas le total de l'examen", async () => {
  // Blueprint de « ml » : 6 sujets, 180 points (35, 35, 30, 30, 25, 25).
  assert.deepEqual(await examPoints("ml", 6), [25, 25, 30, 30, 35, 35], "sans count changé : barème inchangé");
  const eight = await examPoints("ml", 8);
  assert.equal(eight.length, 8);
  assert.equal(sum(eight), 180, `8 exercices : ${eight.join(", ")}`);
  assert.equal(sum(await examPoints("ml", 3)), 180, "3 exercices : le total de l'examen reste");
});

test("barème de l'annale : le plus gros exercice va au slot le plus lourd, étiré sans perdre ses extrêmes", async () => {
  const { exercisePoints } = await import("../lib/exam-points");
  // Slots d'un profil curaté (poids décroissants) ; annale dans l'ordre de ses pages.
  assert.deepEqual(exercisePoints([35, 35, 30, 30, 25, 25], 180, [10, 20, 30, 40, 50, 30]), [50, 40, 30, 30, 20, 10]);
  assert.deepEqual(exercisePoints([45, 45, 45, 45], 180, [12, 18, 25, 45]), [45, 25, 18, 12], "points non ronds gardés tels quels");
  const three = exercisePoints([60, 60, 60], 180, [10, 20, 30, 40, 50, 30]);
  assert.deepEqual(three, [90, 60, 30], "6 → 3 : deux exercices de l'annale par sujet, le 50 et le 10 comptent");
  const seven = exercisePoints(Array(7).fill(25), 175, [10, 20, 30, 40, 50, 30]);
  assert.equal(sum(seven), 180, "le total de l'annale");
  assert.ok(seven[0] >= 4 * seven[6], `profil gardé : ${seven.join(", ")}`);
  assert.deepEqual(exercisePoints([35, 35, 30], 100, null), [35, 35, 30], "sans annale : les poids des slots");
});

/** Un format détecté dans l'annale, avec son total. */
async function annaleTotal(course: string, total: number) {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithCourse(course, async () => {
    await q.ensureTable("format_profile");
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({
      format_summary: "Six problems", duration_min: 180, total_points: total, has_mcq: false, scq_vs_mcq_convention: "",
      question_types: [{ type: "calc", approx_count: 6, share_pct: 100, points_each: 30, note: "" }], sections: [], topics_emphasis: [],
    }));
  });
}

async function addAnnale(course: string, title: string, year: number | null, points: number[]) {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithCourse(course, async () => {
    await q.ensureTable("exam_exercises");
    for (const [i, p] of points.entries()) {
      await q.run(`INSERT INTO exam_exercises (exam_title, exam_year, exam_page, topic, statement, points) VALUES (?,?,?,?,?,?)`, title, year, i + 1, `Sujet ${i + 1}`, "Résumé fictif.", p);
    }
  });
}

test("l'annale donne le barème de chaque exercice : l'examen blanc le reproduit", async () => {
  await addAnnale("ml", "Final fictif", 2025, [10, 20, 30, 40, 50, 30]);
  // Plus ancienne, même titre : un autre barème, jamais mélangé au plus récent.
  await addAnnale("ml", "Final fictif", 2019, [60, 60, 60]);
  // Sans année : jamais prise pour la plus récente.
  await addAnnale("ml", "Final sans date", null, [90, 90]);
  assert.deepEqual(await examPoints("ml", 6), [25, 25, 30, 30, 35, 35], "sans total lu dans l'annale : barème non retenu");
  await annaleTotal("ml", 180);
  assert.deepEqual(await examPoints("ml", 6), [10, 20, 30, 30, 40, 50]);
  const seven = await examPoints("ml", 7);
  assert.equal(sum(seven), 180, `barème ${seven.join(", ")}`);
});

test("un barème qui ne fait pas le total de l'annale (sous-questions, sujets au choix) n'est pas retenu", async () => {
  // Trois sujets au choix notés chacun sur 20 : 60 ≠ 20.
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: "Fictional Essays", code: "FIC 410", language: "en" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await addAnnale(row.id, "Essay exam", 2024, [20, 20, 20]);
  await annaleTotal(row.id, 20);
  const { runWithCourse } = await import("../db/client");
  const { annaleExercisePoints } = await import("../lib/exam-points");
  assert.equal(await runWithCourse(row.id, () => annaleExercisePoints()), null);
});
