/**
 * MÊME EXAMEN, MÊME PRIX (audit fuites I4). La route web, le connecteur MCP et
 * la page d'usage résolvent un examen blanc par la même fonction (mockExamJob) :
 * sur un cours au format QCM, c'est un job qcm au tarif du QCM, jamais le
 * forfait « exam » de 5 crédits pour 40 questions. Un job « exam » qui tombe
 * quand même sur un format QCM (format changé après le devis, ancien job) ne
 * produit pas plus que ce que son prix couvre.
 *
 * Seams : lib/generation mockExamJob, lib/jobs qcmCompositionFor. Aucun appel au modèle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-prix-exam-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory",
  BILLING_ENABLED: "1", CREDITS_COST_JSON: JSON.stringify({ qcm: 4, exam: 5 }),
};
Object.assign(process.env, ENV);
const ALICE = "usr_alice_prix";
let courseId = "";

before(async () => {
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { insertCourse, updateCourseRow } = await import("../db/courses-store");
  const { buildCourseRow } = await import("../lib/course-create");
  const row = buildCourseRow({ name: "Histoire des sciences", code: "HUM-285" }, ALICE);
  await insertCourse(row);
  courseId = row.id;
  await updateCourseRow(courseId, ALICE, { exam_format: JSON.stringify({ kind: "qcm", questionCount: 40, durationMin: 90, language: null }) });
  await reloadCourses();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of Object.keys(ENV)) delete process.env[k];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const inCourse = async <T,>(fn: () => Promise<T>) => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser(ALICE, () => runWithCourse(courseId, fn));
};

test("I4 : cours au format QCM (40 questions) → job qcm, 8 crédits, quel que soit le point d'entrée", async () => {
  const { mockExamJob } = await import("../lib/generation");
  const { costForJob } = await import("../lib/jobs");
  const web = await inCourse(() => mockExamJob({}));                      // POST /api/exams/generate {}
  assert.equal(web.jobType, "qcm");
  assert.deepEqual(JSON.parse(web.target!), { count: 40, openCount: 0 });
  assert.equal(costForJob(web.jobType, web.target), 800, "40 QCM = 2 unités de 4 crédits, pas le forfait de 5");
  const mcp = await inCourse(() => mockExamJob({ count: 40, asked: "qcm" })); // generate_mock_exam format=mcq
  assert.equal(costForJob(mcp.jobType, mcp.target), costForJob(web.jobType, web.target), "même examen, même prix");
});

test("I4 : le focus reste dans la cible, le nombre demandé l'emporte sur celui du format", async () => {
  const { mockExamJob } = await import("../lib/generation");
  const r = await inCourse(() => mockExamJob({ count: 12, focus: "Galilée" }));
  assert.deepEqual(JSON.parse(r.target!), { count: 12, openCount: 0, focus: "Galilée" });
});

test("I4 : un job « exam » (5 crédits) qui tombe sur un format QCM est ramené à ce que son prix couvre", async () => {
  const { qcmCompositionFor, costForJob } = await import("../lib/jobs");
  const paid = costForJob("exam", undefined);
  assert.equal(paid, 500);
  const c = qcmCompositionFor(paid, 40, 6);
  assert.ok(costForJob("qcm", JSON.stringify({ count: c.count, openCount: c.open })) <= paid, JSON.stringify(c));
  assert.deepEqual(c, { count: 14, open: 6 }, "une unité (26 équivalents) : les 6 ouvertes gardées, 14 QCM");
  assert.deepEqual(qcmCompositionFor(paid, 20, 3), { count: 20, open: 3 }, "déjà couvert : inchangé");
  assert.deepEqual(qcmCompositionFor(paid, 2, 20), { count: 2, open: 12 }, "ouvertes réduites si elles dépassent seules");
});
