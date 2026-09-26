/**
 * Revue lot 3-6 — sur Postgres, la purge du cours factice ne doit laisser NI
 * schéma tenant NI ligne `tenants` orphelins : compter les items en passant par
 * runWithCourse amorçait le schéma juste avant de supprimer le cours.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string | undefined>).NODE_ENV = "development";
const env = process.env as Record<string, string | undefined>;

before(() => { delete env.CORTEX_USER; });
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "NODE_ENV"]) delete env[k];
});

const schemas = async () => {
  const { authAll } = await import("../db/auth-store");
  return (await authAll<{ schema_name: string }>(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't_%fictif%'`)).map((r) => r.schema_name);
};
const tenantRows = async () => {
  const { authAll } = await import("../db/auth-store");
  return authAll<{ course: string }>(`SELECT course FROM tenants WHERE course = ?`, "fictif");
};

test("cours factice jamais ouvert : supprimé sans créer de schéma tenant", async () => {
  const { ensureCoursesLoaded, courseExists, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  assert.equal(courseExists("fictif"), true);
  assert.deepEqual(await schemas(), [], "aucun schéma avant");
  const { removeEmptyFakeCourse } = await import("../db/courses-store");
  assert.equal((await removeEmptyFakeCourse()).removed, true);
  await reloadCourses();
  assert.equal(courseExists("fictif"), false);
  assert.deepEqual(await schemas(), [], "la purge n'a pas amorcé de schéma");
  assert.deepEqual(await tenantRows(), []);
});

test("cours factice ouvert mais vide : supprimé, schéma tenant et ligne tenants retirés", async () => {
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
  await runWithUser("owner", () => runWithCourse("fictif", async () => { await q.get(`SELECT count(*) n FROM items`); }));
  assert.equal((await schemas()).length, 1, "schéma amorcé par l'ouverture");
  assert.equal((await tenantRows()).length, 1);
  assert.equal((await removeEmptyFakeCourse()).removed, true);
  assert.deepEqual(await schemas(), []);
  assert.deepEqual(await tenantRows(), []);
});

async function insertFake() {
  const { insertCourse } = await import("../db/courses-store");
  const { LEGACY_COURSES } = await import("../lib/courses-legacy");
  const { reloadCourses } = await import("../lib/courses");
  const f = LEGACY_COURSES.find((c) => c.id === "fictif")!;
  await insertCourse({
    id: f.id, owner_user_id: "owner", name: f.name, short: f.short, code: f.examCode, exam_name: f.examName, exam_kind: f.examKind,
    university: f.university, university_lines: JSON.stringify(f.universityLines), faculty: f.faculty, teachers: "[]", language: "fr",
    profile_id: null, duration_min: f.durationMin, exam_date: null, db_file: f.dbFile, refs_rel: f.refsRel, exams_rel: f.examsRel,
    uploads_rel: f.uploadsRel, content_rel: f.contentRel, created_at: "2026-01-01 00:00:00",
  });
  await reloadCourses();
}

test("lot 4-2 : 0 item mais 1 source → conservé ; erreur de comptage → conservé ; vraiment vide → supprimé", async () => {
  const { removeEmptyFakeCourse } = await import("../db/courses-store");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { courseExists, reloadCourses } = await import("../lib/courses");
  await insertFake();
  await runWithUser("owner", () => runWithCourse("fictif", () => q.run(`INSERT INTO sources (type, title, path) VALUES (?,?,?)`, "pdf", "poly", "refs/poly.pdf")));
  const r1 = await removeEmptyFakeCourse();
  assert.equal(r1.removed, false, `une source sans item compte : ${r1.reason}`);
  const r2 = await removeEmptyFakeCourse({ countRows: async () => { throw new Error("boom"); } });
  assert.equal(r2.removed, false);
  assert.match(r2.reason ?? "", /erreur|boom/i);
  await reloadCourses();
  assert.equal(courseExists("fictif"), true);
  await runWithUser("owner", () => runWithCourse("fictif", () => q.run(`DELETE FROM sources`)));
  assert.equal((await removeEmptyFakeCourse()).removed, true);
  assert.deepEqual(await schemas(), []);
});

test("lot 4-2 : prod-boot ne peut pas échouer à cause de la purge", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("scripts/prod-boot.ts", "utf8");
  const i = src.indexOf("removeEmptyFakeCourse(");
  assert.ok(i > 0);
  const before = src.slice(Math.max(0, i - 400), i);
  assert.match(before, /try\s*\{/, "l'appel doit être dans un try/catch (entrypoint en set -e)");
});
