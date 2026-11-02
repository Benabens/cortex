/**
 * JOURNAL D'UN JOB EN VRAI POSTGRES — job 8 de CS-290 (02/11/2026) : le suivi
 * montrait « Ouverte 2 · P2 » puis directement « Question ouverte 3/3 » ; ni
 * l'étape « Question ouverte 2/3 », ni la cause de son échec. Les étapes du
 * worker sont émises sans attendre (onStep), et logJob relisait puis réécrivait
 * le tableau dans une transaction READ COMMITTED : deux écritures concurrentes
 * se perdaient l'une l'autre. PGlite (une seule connexion) ne le voit pas.
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
const DB = `cortextest_joblog_${process.pid}`;
const DB_URL = (() => { try { const u = new URL(BASE_URL); u.pathname = `/${DB}`; return u.toString(); } catch { return ""; } })();
const DATA_DIR = ENABLED ? fs.mkdtempSync(path.join(os.tmpdir(), "cortex-joblog-pg-")) : "";
const ENV: Record<string, string> = { CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: DB_URL };
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

test("des étapes journalisées en même temps ne se perdent pas", { skip }, async () => {
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  await runWithCourse("ml", async () => {
    const id = await jobs.createJob("qcm");
    const steps = Array.from({ length: 24 }, (_, i) => `étape ${i}`);
    await Promise.all(steps.map((s) => jobs.logJob(id, s)));
    const log = (await jobs.getJob(id))!.log.map((e) => e.msg);
    assert.deepEqual([...log].sort(), [...steps].sort(), `${log.length}/${steps.length} étapes gardées`);
  });
});
