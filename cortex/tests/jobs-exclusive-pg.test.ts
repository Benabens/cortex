/**
 * CRÉATION EXCLUSIVE D'UN JOB EN VRAI POSTGRES — audit generation-ux du 24/11/2026 : quatre
 * clics simultanés sur « Générer l'examen » (quatre onglets) avaient créé trois examens
 * identiques. Sans facturation (propriétaire, dev), la réservation ne sérialise rien : les
 * transactions d'insertion de createJobExclusive tournaient ensemble, chacune voyait « aucun job
 * actif » en READ COMMITTED et insérait le sien. PGlite (une seule connexion) ne le voit pas.
 * Avec facturation, le verrou du solde sérialisait les créations par chance (pg-real-concurrency).
 *
 * Base réelle requise : CORTEX_TEST_PG_URL (nom contenant « test »), sinon sauté ;
 * base DÉDIÉE créée puis supprimée.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const BASE_URL = process.env.CORTEX_TEST_PG_URL ?? "";
const baseDb = (() => { try { return new URL(BASE_URL).pathname.replace(/^\//, ""); } catch { return ""; } })();
const ENABLED = !!BASE_URL && /test/i.test(baseDb);
const skip = ENABLED ? false : "CORTEX_TEST_PG_URL absente (ou base sans « test » dans son nom)";
const DB = `cortextest_jobexcl_${process.pid}`;
const DB_URL = (() => { try { const u = new URL(BASE_URL); u.pathname = `/${DB}`; return u.toString(); } catch { return ""; } })();
const DATA_DIR = ENABLED ? fs.mkdtempSync(path.join(os.tmpdir(), "cortex-jobexcl-pg-")) : "";
const ENV: Record<string, string> = { CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: DB_URL, PG_POOL_MAX: "8", PG_AUTH_POOL_MAX: "8" };
if (ENABLED) Object.assign(process.env, ENV);

async function admin<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

before(async () => {
  if (!ENABLED) return;
  delete process.env.CORTEX_USER;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${DB}"`));
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  if (!ENABLED) return;
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`));
  for (const k of Object.keys(ENV)) delete process.env[k];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("8 créations simultanées du même type dans un cours → un seul job, les autres le retrouvent", { skip }, async () => {
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  await runWithCourse("ml", async () => {
    await jobs.ensureJobsSchema();
    // Plusieurs manches : une course gagnée par chance une fois ne prouve rien.
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(Array.from({ length: 8 }, () => jobs.createJobExclusive("exam")));
      const ids = new Set(results.map((r) => r.id));
      assert.equal(ids.size, 1, `manche ${round} : jobs distincts ${[...ids].join(",")}`);
      assert.equal(results.filter((r) => !r.existing).length, 1);
      await jobs.setJob([...ids][0], { status: "canceled" });
    }
  });
});

test("le verrou est propre au type : un examen et un QCM lancés ensemble ont chacun leur job", { skip }, async () => {
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  await runWithCourse("ml", async () => {
    const [exam, qcm] = await Promise.all([jobs.createJobExclusive("exam"), jobs.createJobExclusive("qcm")]);
    assert.notEqual(exam.id, qcm.id);
    assert.equal(exam.existing || qcm.existing, false);
  });
});

test("aide déjà réservée (insertReservedJob) : 8 insertions simultanées → une seule, les autres rendent leur réservation", { skip }, async () => {
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  await runWithCourse("ml", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => jobs.insertReservedJob("drill", "{}", `test:drill:${i}`)));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(results.filter((r) => !r.existing).length, 1);
  });
});
