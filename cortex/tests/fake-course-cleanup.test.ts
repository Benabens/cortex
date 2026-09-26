/**
 * Le cours factice « Quantitative Oenology » (id `fictif`) servait de preuve
 * zéro-code : la migration du catalogue historique le créait aussi en
 * production, chez le propriétaire. En production il n'est plus créé, et une
 * migration idempotente le retire s'il est VIDE (aucun item) — sans toucher à
 * rien d'autre.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Le cours factice n'est migré qu'hors production : le shell de dev peut exporter NODE_ENV=production.
(process.env as Record<string, string | undefined>).NODE_ENV = "development";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fictif-"));
process.env.CORTEX_DATA_DIR = tmp;
const env = process.env as Record<string, string | undefined>;

before(() => { delete env.CORTEX_USER; });
after(() => { for (const k of ["CORTEX_DATA_DIR", "NODE_ENV"]) delete env[k]; fs.rmSync(tmp, { recursive: true, force: true }); });

test("hors production : le cours factice existe (dev / tests) ; la purge le retire s'il est vide et laisse les autres", async () => {
  const { ensureCoursesLoaded, courseExists, listCourseIds, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  assert.equal(courseExists("fictif"), true);
  const { removeEmptyFakeCourse } = await import("../db/courses-store");
  const r1 = await removeEmptyFakeCourse();
  assert.equal(r1.removed, true);
  await reloadCourses();
  assert.equal(courseExists("fictif"), false);
  for (const id of ["cs-202", "ml", "algo"]) assert.ok(listCourseIds().includes(id), `${id} conservé`);
  const r2 = await removeEmptyFakeCourse();
  assert.equal(r2.removed, false, "idempotent");
});

test("un cours factice NON vide n'est jamais supprimé", async () => {
  const { insertCourse, removeEmptyFakeCourse } = await import("../db/courses-store");
  const { LEGACY_COURSES } = await import("../lib/courses-legacy");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const f = LEGACY_COURSES.find((c) => c.id === "fictif")!;
  await insertCourse({
    id: f.id, owner_user_id: "owner", name: f.name, short: f.short, code: f.examCode, exam_name: f.examName, exam_kind: f.examKind,
    university: f.university, university_lines: JSON.stringify(f.universityLines), faculty: f.faculty, teachers: "[]", language: "fr",
    profile_id: null, duration_min: f.durationMin, exam_date: null, db_file: f.dbFile, refs_rel: f.refsRel, exams_rel: f.examsRel,
    uploads_rel: f.uploadsRel, content_rel: f.contentRel, created_at: "2026-01-01 00:00:00",
  });
  await reloadCourses();
  await runWithUser("owner", () => runWithCourse("fictif", () =>
    q.run(`INSERT INTO items (type, title, text) VALUES (?,?,?)`, "subject", "Un item", "texte"),
  ));
  const r = await removeEmptyFakeCourse();
  assert.equal(r.removed, false);
  assert.match(r.reason ?? "", /item/i);
});

test("en production, la migration du catalogue ne crée plus le cours factice", async () => {
  const { LEGACY_COURSES, legacyCoursesFor } = await import("../lib/courses-legacy");
  assert.ok(LEGACY_COURSES.some((c) => c.id === "fictif"), "le catalogue brut le garde pour le dev");
  assert.ok(!legacyCoursesFor({ NODE_ENV: "production" }).some((c) => c.id === "fictif"));
  assert.ok(legacyCoursesFor({ NODE_ENV: "development" }).some((c) => c.id === "fictif"));
});
