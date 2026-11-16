/**
 * scripts/delete-course.ts — le script d'administration que lib/course-deletion
 * désigne pour supprimer un cours du compte PROPRIÉTAIRE (refusé depuis
 * l'application). Dry-run par défaut, --yes pour exécuter ; résout --user par
 * id ou par e-mail ; refuse toujours les cours historiques/partagés.
 *
 * Seams : runDeleteCourse (scripts/delete-course.ts), resolveUserId (lib/course-deletion.ts).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-delcourse-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
delete process.env.CORTEX_USER;

before(async () => {
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { authRun } = await import("../db/auth-store");
  const { userSlug } = await import("../db/context");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");

  await authRun(`INSERT INTO users (id, email) VALUES (?, ?)`, "owner", "ben@cortexexam.com");
  await insertCourse({
    id: "a-virer", owner_user_id: "owner", name: "a-virer", short: "a-virer", code: null, exam_name: "a-virer",
    exam_kind: "Final", university: null, university_lines: "[]", faculty: null, teachers: "[]", language: "fr",
    profile_id: null, duration_min: 120, exam_date: null, db_file: null, refs_rel: null, exams_rel: null,
    uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
  await reloadCourses();
  await runWithUser("owner", () => runWithCourse("a-virer", () => q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, "t", 1)));
  const dir = path.join(tmp, "u", userSlug("owner"), "a-virer", "refs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "annale.pdf"), "%PDF-1");
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("résout --user par e-mail (insensible à la casse)", async () => {
  const { resolveUserId } = await import("../lib/course-deletion");
  assert.equal(await resolveUserId("BEN@cortexexam.com"), "owner");
  assert.equal(await resolveUserId("owner"), "owner");
  assert.equal(await resolveUserId("inconnu@x.fr"), undefined);
});

test("dry-run (sans --yes) : décrit ce qui serait supprimé et ne touche rien", async () => {
  const { runDeleteCourse } = await import("../scripts/delete-course");
  const { courseExists } = await import("../lib/courses");
  const out = await runDeleteCourse({ user: "ben@cortexexam.com", course: "a-virer", yes: false });
  assert.match(out, /dry-run/i);
  assert.match(out, /a-virer/);
  assert.match(out, /schéma Postgres/);
  assert.match(out, /fichiers : 1/);
  assert.equal(courseExists("a-virer"), true, "rien n'a été supprimé");
});

test("--yes supprime vraiment le cours du propriétaire (schéma, fichiers, fiche)", async () => {
  const { runDeleteCourse } = await import("../scripts/delete-course");
  const { courseExists } = await import("../lib/courses");
  const { userSlug } = await import("../db/context");
  const out = await runDeleteCourse({ user: "owner", course: "a-virer", yes: true });
  assert.match(out, /Supprimé/);
  assert.equal(courseExists("a-virer"), false);
  assert.equal(fs.existsSync(path.join(tmp, "u", userSlug("owner"), "a-virer")), false);
});

test("refuse toujours un cours historique, même avec --yes", async () => {
  const { runDeleteCourse } = await import("../scripts/delete-course");
  const { courseExists } = await import("../lib/courses");
  const out = await runDeleteCourse({ user: "owner", course: "cs-202", yes: true });
  assert.match(out, /Échec/);
  assert.match(out, /historique|référence/i);
  assert.equal(courseExists("cs-202"), true);
});

test("utilisateur introuvable → erreur explicite", async () => {
  const { runDeleteCourse } = await import("../scripts/delete-course");
  await assert.rejects(() => runDeleteCourse({ user: "personne@x.fr", course: "a-virer", yes: false }), /introuvable/);
});
