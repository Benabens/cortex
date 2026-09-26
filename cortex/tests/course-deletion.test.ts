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

// ── Lot 4b : schéma partagé, marqueur de suppression, jobs, cours historiques ──

async function openTenant(user: string, course: string) {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithUser(user, () => runWithCourse(course, () => q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, `${user}-${course}`, 2)));
}
const schemaExists = async (name: string) => {
  const { authGet } = await import("../db/auth-store");
  return !!(await authGet(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, name));
};

test("4b-1 : un schéma partagé par une autre ligne du registre n'est jamais supprimé (409)", async () => {
  const { authGet, authRun } = await import("../db/auth-store");
  const { reloadCourses } = await import("../lib/courses");
  await ownedCourse("partage", "carol"); await reloadCourses();
  await openTenant("carol", "partage");
  const t = (await authGet<{ schema_name: string }>(`SELECT schema_name FROM tenants WHERE user_id = ? AND course = ?`, "carol", "partage"))!;
  await authRun(`INSERT INTO tenants (user_id, course, schema_name, last_seen) VALUES (?,?,?,?)`, "carol", "partage-bis", t.schema_name, "2026-01-01 00:00:00");
  const r = await del("partage", "carol");
  assert.equal(r.status, 409, await r.clone().text());
  assert.match((await r.json()).error, /partag/i);
  assert.equal(await schemaExists(t.schema_name), true);
  await authRun(`DELETE FROM tenants WHERE user_id = ? AND course = ?`, "carol", "partage-bis");
  assert.equal((await del("partage", "carol")).status, 200);
  assert.equal(await schemaExists(t.schema_name), false);
});

test("4b-4 : pendant la suppression, aucun job ne démarre ; un job dont l'annulation échoue bloque la suppression", async () => {
  const { reloadCourses } = await import("../lib/courses");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { markCourseDeleting, unmarkCourseDeleting, isCourseDeleting, deleteCourseWithData } = await import("../lib/course-deletion");
  const jobs = await import("../lib/jobs");
  await ownedCourse("enfuite", "dan"); await reloadCourses();
  await openTenant("dan", "enfuite");
  await markCourseDeleting("dan", "enfuite");
  assert.equal(await isCourseDeleting("dan", "enfuite"), true);
  await runWithUser("dan", () => runWithCourse("enfuite", async () => {
    await assert.rejects(() => jobs.createJobExclusive("exam"), (e: Error) => e instanceof jobs.ReservationRefused && (e as { status?: number }).status === 409);
  }));
  await unmarkCourseDeleting("dan", "enfuite");
  const r = await deleteCourseWithData("dan", "enfuite", { cancelJobs: async (_u, _c, errors) => { errors.push("cancel job enfuite#1: boom"); } });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 409);
  assert.equal(await isCourseDeleting("dan", "enfuite"), false, "le marqueur est levé après un refus");
  const { courseExists } = await import("../lib/courses");
  assert.equal(courseExists("enfuite"), true, "rien n'a été supprimé");
  assert.equal((await deleteCourseWithData("dan", "enfuite")).ok, true);
});

test("4b-4 : le worker ne recrée pas un schéma pour un cours supprimé", async () => {
  const { runWithUser, tenantSchema } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { reloadCourses } = await import("../lib/courses");
  const jobs = await import("../lib/jobs");
  await ownedCourse("ephemere", "eve"); await reloadCourses();
  await openTenant("eve", "ephemere");
  assert.equal((await del("ephemere", "eve")).status, 200);
  const schema = tenantSchema("eve", "ephemere");
  assert.equal(await schemaExists(schema), false);
  const ok = await runWithUser("eve", () => runWithCourse("ephemere", () => jobs.assertJobCourseOwned(1, "ephemere")));
  assert.equal(ok, false);
  assert.equal(await schemaExists(schema), false, "assertJobCourseOwned n'a rien écrit dans un tenant disparu");
  const fs = await import("node:fs");
  const src = fs.readFileSync("scripts/run-job.ts", "utf8").slice(fs.readFileSync("scripts/run-job.ts", "utf8").indexOf("async function main()"));
  const guard = src.search(/ownsCourse\(|isCourseDeleting\(/);
  const first = src.indexOf("await getJob(");
  assert.ok(guard > 0 && guard < first, "run-job vérifie le cours AVANT toute lecture du tenant (getJob amorce le schéma)");
});

test("4b-5 : refus explicite des cours historiques (par id) et de tout cours du compte propriétaire", async () => {
  const { reloadCourses } = await import("../lib/courses");
  // Un cours créé depuis l'interface mais qui porte un id historique (paths NULL) : refusé quand même.
  await ownedCourse("ml", "frank").catch(() => undefined); // l'id ml peut déjà exister (catalogue) : on teste alors l'existant
  await reloadCourses();
  const { deleteCourseWithData } = await import("../lib/course-deletion");
  const r1 = await deleteCourseWithData("frank", "ml");
  assert.equal(r1.ok, false);
  assert.ok(!r1.ok && [404, 409].includes(r1.status));
  if (!r1.ok && r1.status === 409) assert.match(r1.error, /historique/i);
  // Le compte propriétaire : même un cours créé depuis l'interface est refusé.
  await ownedCourse("perso-owner", "owner"); await reloadCourses();
  const r2 = await deleteCourseWithData("owner", "perso-owner");
  assert.equal(r2.ok, false);
  assert.equal(!r2.ok && r2.status, 409);
  assert.match(!r2.ok ? r2.error : "", /propriétaire/i);
});
