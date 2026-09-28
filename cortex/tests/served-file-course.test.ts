/**
 * PRÉ-LANCEMENT 3 — les routes qui servent des fichiers (/refs, /exam, /uploads,
 * /csrc) vérifiaient l'appartenance du cours résolu par `courseOf` (paramètre
 * d'URL PUIS en-tête x-cortex-course) mais calculaient le chemin depuis le seul
 * paramètre d'URL. Sans `?course=`, la garde passait sur « mon » cours et le
 * chemin retombait sur le cours par défaut, dont les annales sont PARTAGÉES :
 * un en-tête suffisait à lire le corpus de référence de l'instance.
 * Le chemin doit venir du contexte installé par la garde.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-served-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
const env = process.env as Record<string, string | undefined>;

const SECRET = "annale-de-reference.pdf";
const MINE = "mon-annale.pdf";

before(async () => {
  delete env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../lib/courses");
  const { insertCourse } = await import("../db/courses-store");
  await ensureCoursesLoaded();
  await insertCourse({
    id: "moncours", owner_user_id: "alice", name: "Mon cours", short: "MC", code: null, exam_name: "Mon cours",
    exam_kind: "Final", university: null, university_lines: "[]", faculty: null, teachers: "[]", language: "fr",
    profile_id: null, duration_min: 120, exam_date: null, db_file: null, refs_rel: null, exams_rel: null,
    uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
  await reloadCourses();
  // Corpus PARTAGÉ du cours de référence (chemins historiques) + fichiers du cours d'alice.
  const shared = coursePaths("cs-202");
  for (const dir of [shared.refsDir, shared.examsDir, shared.uploadsDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(shared.refsDir, SECRET), "CORPUS DE REFERENCE");
  fs.writeFileSync(path.join(shared.examsDir, "exam-1.pdf"), "%PDF reference");
  fs.writeFileSync(path.join(shared.uploadsDir, SECRET), "capture de reference");
  const { runWithUser } = await import("../db/context");
  const mine = runWithUser("alice", () => coursePaths("moncours"));
  for (const dir of [mine.refsDir, mine.examsDir, mine.uploadsDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(mine.refsDir, MINE), "MON CORPUS");
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Requête d'alice sur SON cours, annoncé par l'en-tête seul (aucun ?course=). */
const byHeader = (url: string) =>
  new NextRequest(`http://cortex.test${url}`, { headers: { "x-cortex-user": "alice", "x-cortex-course": "moncours" } });

test("/refs : l'en-tête de cours ne donne pas accès au corpus partagé, et sert bien le cours annoncé", async () => {
  const { GET } = await import("../app/refs/[file]/route");
  const leak = await GET(byHeader(`/refs/${SECRET}`), { params: Promise.resolve({ file: SECRET }) });
  assert.equal(leak.status, 404, "le corpus de référence ne doit pas sortir");
  const ok = await GET(byHeader(`/refs/${MINE}`), { params: Promise.resolve({ file: MINE }) });
  assert.equal(ok.status, 200, "le cours annoncé par l'en-tête est bien celui servi");
  assert.equal(await ok.text(), "MON CORPUS");
});

test("/uploads : même règle", async () => {
  const { GET } = await import("../app/uploads/[file]/route");
  const leak = await GET(byHeader(`/uploads/${SECRET}`), { params: Promise.resolve({ file: SECRET }) });
  assert.equal(leak.status, 404);
});

test("/exam : même règle (l'artefact du cours de référence n'est pas servi)", async () => {
  const { GET } = await import("../app/exam/[file]/route");
  const leak = await GET(byHeader("/exam/exam-1.pdf"), { params: Promise.resolve({ file: "exam-1.pdf" }) });
  assert.equal(leak.status, 404);
});

test("/csrc : même règle", async () => {
  const { GET } = await import("../app/csrc/route");
  const leak = await GET(byHeader(`/csrc?p=refs/${SECRET}`));
  assert.equal(leak.status, 404, await leak.clone().text());
});

test("le propriétaire accède normalement au corpus de référence avec ?course=cs-202", async () => {
  const { GET } = await import("../app/refs/[file]/route");
  const req = new NextRequest(`http://cortex.test/refs/${SECRET}?course=cs-202`, { headers: { "x-cortex-user": "owner" } });
  const r = await GET(req, { params: Promise.resolve({ file: SECRET }) });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(await r.text(), "CORPUS DE REFERENCE");
});
