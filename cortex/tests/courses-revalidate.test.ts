import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.CORTEX_MIGRATE_LEGACY_COURSES = "0";

import { authRun } from "../db/auth-store";
import { deleteCourseRow, insertCourse, updateCourseRow, type CourseRow } from "../db/courses-store";
import {
  ensureCoursesLoaded,
  listCoursesOf,
  reloadCourses,
  resetCoursesCache,
  revalidateCourses,
  tryGetCourse,
} from "../lib/courses";
import { resolveCourse } from "../lib/mcp/courses";

/**
 * Un cours écrit par un AUTRE processus (scripts/review-account.ts lancé dans le
 * conteneur, le worker) doit apparaître dans le serveur web sans redémarrage.
 * Ici, l'« autre processus » est simulé en écrivant en base sans toucher au cache.
 */

const USER = "usr_demo";

function row(id: string, createdAt = new Date().toISOString()): CourseRow {
  return {
    id, owner_user_id: USER, name: `Cours ${id}`, short: id, code: id.toUpperCase(),
    exam_name: null, exam_kind: null, university: null, university_lines: null, faculty: null,
    teachers: null, language: "en", profile_id: null, duration_min: null, exam_date: null,
    db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null,
    created_at: createdAt,
  };
}

beforeEach(async () => {
  process.env.CORTEX_OWNER_USER_ID = USER; // pas de limite de création dans ces tests
  await authRun(`DELETE FROM courses`);
  resetCoursesCache();
  await reloadCourses();
});

test("cours créé hors du processus : introuvable dans le cache, trouvé par resolveCourse sans redémarrage", async () => {
  await insertCourse(row("demo-101"));
  assert.equal(tryGetCourse("demo-101"), undefined, "le cache n'a pas encore vu l'écriture");
  const hit = await resolveCourse(USER, "DEMO-101");
  assert.equal(hit.id, "demo-101");
  assert.equal(tryGetCourse("demo-101")?.id, "demo-101", "le cache est rechargé");
});

test("list_courses : ensureCoursesLoaded revalide après l'intervalle", async () => {
  await insertCourse(row("demo-102"));
  // Intervalle minimal entre deux relectures (1 s) : on l'attend pour de vrai.
  await new Promise((r) => setTimeout(r, 1100));
  await ensureCoursesLoaded();
  assert.deepEqual(listCoursesOf(USER).map((c) => c.id), ["demo-102"]);
});

test("modification et suppression hors du processus sont vues", async () => {
  await insertCourse(row("demo-103"));
  await revalidateCourses(true);
  await updateCourseRow("demo-103", USER, { name: "Probabilités (démo)" });
  await revalidateCourses(true);
  assert.equal(tryGetCourse("demo-103")?.name, "Probabilités (démo)");
  await deleteCourseRow("demo-103", USER);
  await revalidateCourses(true);
  assert.equal(tryGetCourse("demo-103"), undefined);
});

test("écriture SQL directe sans version : rattrapée par le nombre de cours", async () => {
  await authRun(
    `INSERT INTO courses (id, owner_user_id, name, short, created_at) VALUES (?,?,?,?,?)`,
    "demo-104", USER, "Cours brut", "D", "2020-01-01",
  );
  await revalidateCourses(true);
  assert.equal(tryGetCourse("demo-104")?.name, "Cours brut");
});

test("catalogue inchangé : pas de rechargement", async () => {
  await insertCourse(row("demo-105"));
  await revalidateCourses(true);
  const before = tryGetCourse("demo-105");
  await revalidateCourses(true);
  assert.equal(tryGetCourse("demo-105"), before, "même objet : le cache n'a pas été rempli à nouveau");
});

test("cours d'un autre compte : toujours introuvable après relecture", async () => {
  await insertCourse({ ...row("autre-201"), owner_user_id: "usr_autre" });
  await assert.rejects(resolveCourse(USER, "autre-201"), /introuvable/);
});
