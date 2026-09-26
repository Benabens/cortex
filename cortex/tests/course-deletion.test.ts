/**
 * LOT 4-3 — DELETE /api/courses/[id] supprime AUSSI les données du cours :
 * schéma tenant, ligne tenants, fichiers data/u/<slug>/<cours>/. Les cours
 * historiques du propriétaire (cs-202, algo, ml : chemins partagés, invariant
 * du cours de référence) sont refusés avec un message.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coursedel-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
delete process.env.CORTEX_USER;

async function ownedCourse(id: string, owner: string) {
  const { insertCourse } = await import("../db/courses-store");
  await insertCourse({
    id, owner_user_id: owner, name: id, short: id, code: null, exam_name: id, exam_kind: "Final", university: null,
    university_lines: "[]", faculty: null, teachers: "[]", language: "fr", profile_id: null, duration_min: 120, exam_date: null,
    db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
}
const del = async (id: string, user: string) => {
  const { DELETE } = await import("../app/api/courses/[id]/route");
  return DELETE(new NextRequest(`http://cortex.test/api/courses/${id}`, { method: "DELETE", headers: { "x-cortex-user": user } }), { params: Promise.resolve({ id }) });
};

before(async () => {
  const { runWithUser, userSlug } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  await ownedCourse("reseaux", "alice");
  await ownedCourse("reseaux2", "bob");
  await reloadCourses();
  for (const [u, c] of [["alice", "reseaux"], ["bob", "reseaux2"]]) {
    await runWithUser(u, () => runWithCourse(c, () => q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, `${u}-topic`, 2)));
    const dir = path.join(tmp, "u", userSlug(u), c, "refs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "annale.pdf"), "%PDF");
  }
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("supprimer son cours efface schéma, ligne tenants, fichiers et fiche — le cours de bob est intact", async () => {
  const { authAll, authGet } = await import("../db/auth-store");
  const { userSlug } = await import("../db/context");
  const { courseExists, reloadCourses } = await import("../lib/courses");
  const before = await authGet<{ schema_name: string }>(`SELECT schema_name FROM tenants WHERE user_id = ? AND course = ?`, "alice", "reseaux");
  assert.ok(before, "tenant d'alice enregistré");
  const r = await del("reseaux", "alice");
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).dataDeleted, true);
  const schemas = await authAll<{ schema_name: string }>(`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?`, before!.schema_name);
  assert.deepEqual(schemas, [], "schéma tenant supprimé");
  assert.equal(await authGet(`SELECT 1 FROM tenants WHERE user_id = ? AND course = ?`, "alice", "reseaux"), undefined);
  assert.equal(fs.existsSync(path.join(tmp, "u", userSlug("alice"), "reseaux")), false, "fichiers supprimés");
  await reloadCourses();
  assert.equal(courseExists("reseaux"), false);
  // bob : rien n'a bougé
  assert.ok(await authGet(`SELECT 1 FROM tenants WHERE user_id = ? AND course = ?`, "bob", "reseaux2"));
  assert.equal(fs.existsSync(path.join(tmp, "u", userSlug("bob"), "reseaux2", "refs", "annale.pdf")), true);
  assert.equal(courseExists("reseaux2"), true);
});

test("le cours d'un autre → 404 ; un cours historique du propriétaire → 409 sans rien toucher", async () => {
  const r404 = await del("reseaux2", "alice");
  assert.equal(r404.status, 404);
  const { courseExists } = await import("../lib/courses");
  const r409 = await del("cs-202", "owner");
  assert.equal(r409.status, 409, await r409.clone().text());
  assert.match((await r409.json()).error, /historique|référence/i);
  assert.equal(courseExists("cs-202"), true);
});
