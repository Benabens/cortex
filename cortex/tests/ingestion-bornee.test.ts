/**
 * AUDIT FUITES DU 17/11, B3 — l'ingestion contournait tout : ni quota du jour, ni place à elle
 * dans la file. Un compte gratuit qui relance « Terminer l'import » en boucle sur ses 20 cours
 * occupait les 4 places de la file globale (pdftoppm, extraction), et les générations PAYÉES
 * attendaient derrière. Désormais :
 *  - DAILY_INGEST_QUOTA ingestions par compte et par jour (défaut 20), propriétaire exempté ;
 *  - une file à part : MAX_GLOBAL_INGEST_JOBS ingestions simultanées (défaut 2), qui ne prennent
 *    jamais une place de MAX_GLOBAL_JOBS. Une génération payée ne voit jamais d'import devant elle.
 *
 * Seams : jobs.createJobExclusive("ingest"), job-queue (admitJob, nextToStart), jobs.startWorker.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ingest-borne-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.DAILY_INGEST_QUOTA = "2";
process.env.MAX_GLOBAL_JOBS = "1";
process.env.MAX_GLOBAL_INGEST_JOBS = "2";
const ENV_KEYS = ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "DAILY_INGEST_QUOTA", "MAX_GLOBAL_JOBS", "MAX_GLOBAL_INGEST_JOBS", "CORTEX_OWNER_USER_ID"];

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
beforeEach(async () => {
  const { authRun } = await import("../db/auth-store");
  await authRun(`DELETE FROM job_queue`);
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ENV_KEYS) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function asUser<T>(user: string, fn: () => Promise<T>): Promise<T> {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser(user, () => runWithCourse("ml", fn));
}

/** Lance une ingestion puis la termine (le job actif du même type serait sinon réutilisé). */
async function ingestOnce(user: string) {
  const jobs = await import("../lib/jobs");
  const { q } = await import("../db/q");
  return asUser(user, async () => {
    const r = await jobs.createJobExclusive("ingest");
    await q.run(`UPDATE jobs SET status = 'done' WHERE id = ?`, r.id);
    return r;
  });
}

test("B3 : DAILY_INGEST_QUOTA ingestions par compte et par jour, puis 429 ; un autre compte n'est pas touché", async () => {
  const jobs = await import("../lib/jobs");
  await ingestOnce("eve");
  await ingestOnce("eve");
  await assert.rejects(
    () => asUser("eve", () => jobs.createJobExclusive("ingest")),
    (e: Error & { status?: number }) => e instanceof jobs.ReservationRefused && e.status === 429 && /import/i.test(e.message),
  );
  await ingestOnce("fred");
});

test("B3 : un import déjà en cours est réutilisé, il ne consomme pas le quota du jour", async () => {
  const jobs = await import("../lib/jobs");
  const { q } = await import("../db/q");
  const first = await asUser("gina", () => jobs.createJobExclusive("ingest"));
  const again = await asUser("gina", () => jobs.createJobExclusive("ingest"));
  assert.equal(again.existing, true);
  assert.equal(again.id, first.id);
  await asUser("gina", () => q.run(`UPDATE jobs SET status = 'done' WHERE id = ?`, first.id));
  await ingestOnce("gina"); // 2e du jour : passe
});

test("B3 : le propriétaire de l'instance n'est pas borné", async () => {
  process.env.CORTEX_OWNER_USER_ID = "patron";
  try {
    for (let i = 0; i < 3; i++) await ingestOnce("patron");
  } finally {
    delete process.env.CORTEX_OWNER_USER_ID;
  }
});

test("B3 : file à part — les imports n'occupent jamais la place d'une génération payée", async () => {
  const { admitJob, nextToStart, releaseJob } = await import("../lib/job-queue");
  assert.deepEqual(await admitJob("a", "ml", 1, "ingest"), { admitted: true });
  assert.deepEqual(await admitJob("b", "ml", 1, "ingest"), { admitted: true });
  assert.deepEqual(await admitJob("c", "ml", 1, "ingest"), { admitted: false, position: 1 }, "deux imports au plus");
  // La seule place des générations (MAX_GLOBAL_JOBS=1) est libre malgré les imports.
  assert.deepEqual(await admitJob("d", "ml", 1), { admitted: true });
  assert.deepEqual(await admitJob("e", "ml", 1), { admitted: false, position: 1 }, "rang compté parmi les générations seulement");
  await releaseJob("a", "ml", 1);
  assert.deepEqual(await nextToStart(), [{ user: "c", course: "ml", jobId: 1 }], "la place d'import libérée va à l'import en attente");
  await releaseJob("d", "ml", 1);
  assert.deepEqual(
    (await nextToStart()).map((e) => e.user).sort(),
    ["c", "e"],
  );
});

test("B3 : startWorker d'un import, file des imports pleine : il attend son tour, les générations gardent leur place", async () => {
  const jobs = await import("../lib/jobs");
  const { admitJob } = await import("../lib/job-queue");
  const { q } = await import("../db/q");
  await admitJob("x", "ml", 1, "ingest");
  await admitJob("y", "ml", 1, "ingest");
  await asUser("hugo", async () => {
    await jobs.ensureJobsSchema();
    const id = await q.insert(`INSERT INTO jobs (type, target, status, current_step, progress) VALUES ('ingest', NULL, 'queued', 'En file…', 0)`);
    await jobs.startWorker(id, "ml");
    const row = await q.get<{ status: string; pid: number | null; current_step: string }>(`SELECT status, pid, current_step FROM jobs WHERE id = ?`, id);
    assert.equal(row?.status, "queued");
    assert.equal(row?.pid, null, "aucun worker lancé");
    assert.match(row!.current_step, /file d'attente/i);
    assert.match(row!.current_step, /import/i);
  });
  assert.deepEqual(await admitJob("z", "ml", 1), { admitted: true }, "la génération payée démarre");
});
