/**
 * Le battement de cœur prime sur le PID (audit du 14/11/2026, axe 5).
 *
 * Sans volume (stockage objet) ou avec un second réplica, l'ancien et le nouveau
 * conteneur se recouvrent pendant un déploiement : le PID d'un worker qui tourne
 * ailleurs n'existe pas ici. Le déclarer zombie relancerait un second worker sur
 * le même job (coût du modèle payé deux fois). Un battement récent dit qu'il vit,
 * où qu'il tourne ; un battement ancien et un PID absent disent qu'il est mort.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-heartbeat-"));
process.env.CORTEX_DATA_DIR = tmp;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => { delete process.env.CORTEX_DATA_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

const ABSENT_PID = 999_999; // aucun process de ce numéro ici : le worker tourne sur un autre conteneur, ou est mort

async function runningJob(heartbeatAgoMs: number): Promise<number> {
  const { q, nowStr } = await import("../db/q");
  return q.insert(
    `INSERT INTO jobs (type, target, status, current_step, progress, pid, heartbeat_at, attempts, max_attempts, credit_ref, created_at, updated_at)
     VALUES ('ingest', NULL, 'running', 'Ingestion…', 30, ?, ?, 0, 2, NULL, ?, ?)`,
    ABSENT_PID, nowStr(-heartbeatAgoMs), nowStr(-20 * 60_000), nowStr(-heartbeatAgoMs),
  );
}

async function status(id: number): Promise<string | undefined> {
  const { q } = await import("../db/q");
  return (await q.get<{ status: string }>(`SELECT status FROM jobs WHERE id = ?`, id))?.status;
}

test("PID absent ici mais battement d'il y a 30 s : le worker vit ailleurs, le job n'est pas touché", async () => {
  const jobs = await import("../lib/jobs");
  const { runWithCourse } = await import("../db/client");
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    const id = await runningJob(30_000);
    await jobs.reconcileStaleJobs();
    assert.equal(await status(id), "running");
  });
});

test("PID absent et plus aucun battement depuis 10 min : zombie, remis en file", async () => {
  const jobs = await import("../lib/jobs");
  const { runWithCourse } = await import("../db/client");
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    const id = await runningJob(10 * 60_000);
    await jobs.reconcileStaleJobs();
    assert.equal(await status(id), "queued");
  });
});
