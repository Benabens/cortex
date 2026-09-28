/**
 * Le mémo du schéma (db/q.ts) n'était purgé que dans la branche PostgreSQL de la
 * suppression d'un cours. Sur sqlite — le mode de développement par défaut — le
 * fichier de base part avec le dossier du cours mais le mémo survivait : recréer
 * un cours du même identifiant dans le même process donnait une base sans table,
 * que `ensureTable` refusait de recréer puisqu'il se croyait déjà passé.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

(process.env as Record<string, string | undefined>).NODE_ENV = "development";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-memo-"));
process.env.CORTEX_DATA_DIR = tmp;
const env = process.env as Record<string, string | undefined>;
delete env.DB_DRIVER;
delete env.DATABASE_URL;

async function creerCours(id: string, owner: string): Promise<void> {
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  await insertCourse({
    id, owner_user_id: owner, name: id, short: id, code: null, exam_name: id, exam_kind: "Final", university: null,
    university_lines: "[]", faculty: null, teachers: "[]", language: "fr", profile_id: null, duration_min: 120,
    exam_date: null, db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null,
    created_at: "2026-09-01 00:00:00",
  });
  await reloadCourses();
}

before(async () => {
  delete env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "NODE_ENV"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cours supprimé puis recréé (sqlite) : la table est bien recréée", async () => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { deleteCourseWithData } = await import("../lib/course-deletion");

  await creerCours("optique", "zoe");
  await runWithUser("zoe", () => runWithCourse("optique", async () => {
    await q.ensureTable("weaknesses");
    await q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, "diffraction", 2);
  }));

  const r = await deleteCourseWithData("zoe", "optique", { cancelJobs: async () => {} });
  assert.equal(r.ok, true, "la suppression aboutit");

  await creerCours("optique", "zoe");
  await runWithUser("zoe", () => runWithCourse("optique", async () => {
    await q.ensureTable("weaknesses");
    // Sans purge du mémo, cet INSERT échouait sur « no such table: weaknesses ».
    await q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, "interférences", 3);
    const rows = await q.all<{ topic: string }>(`SELECT topic FROM weaknesses`);
    assert.deepEqual(rows.map((x) => x.topic), ["interférences"], "base neuve : rien de l'ancien cours");
  }));
});
