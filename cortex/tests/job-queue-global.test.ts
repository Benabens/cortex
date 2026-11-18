/**
 * AUDIT DU 14/11/2026, n° 6 — aucun plafond GLOBAL de jobs : MAX_ACTIVE_JOBS vaut par compte,
 * chaque job est un process avec son propre LLM_MAX_CONCURRENCY. 30 comptes × 2 jobs = 60 process
 * Node et jusqu'à 360 appels simultanés dans un seul conteneur (OOM, vague de 429).
 * Désormais MAX_GLOBAL_JOBS workers au plus pour toute l'instance ; au-delà, file FIFO.
 * Aucun vrai worker n'est lancé : les tests passent par la file et par un startWorker refusé.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueEntry } from "../lib/job-queue";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-jobqueue-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_GLOBAL_JOBS = "2";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
beforeEach(async () => {
  const { authRun } = await import("../db/auth-store");
  await authRun(`DELETE FROM job_queue`);
  process.env.MAX_GLOBAL_JOBS = "2";
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "MAX_GLOBAL_JOBS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("plafond atteint : les deux premiers jobs démarrent, le troisième attend en tête de file", async () => {
  const { admitJob } = await import("../lib/job-queue");
  assert.deepEqual(await admitJob("alice", "algo", 1), { admitted: true });
  assert.deepEqual(await admitJob("bob", "algo", 1), { admitted: true });
  assert.deepEqual(await admitJob("carol", "algo", 1), { admitted: false, position: 1 });
  assert.deepEqual(await admitJob("dave", "algo", 1), { admitted: false, position: 2 });
});

test("FIFO : une place libérée revient au plus ancien en attente, pas au dernier arrivé", async () => {
  const { admitJob, releaseJob, nextToStart } = await import("../lib/job-queue");
  await admitJob("alice", "algo", 1);
  await admitJob("bob", "algo", 1);
  await admitJob("carol", "algo", 1);
  await admitJob("dave", "algo", 1);
  await releaseJob("alice", "algo", 1);
  assert.deepEqual(await nextToStart(), [{ user: "carol", course: "algo", jobId: 1 }]);
  assert.deepEqual(await admitJob("dave", "algo", 1), { admitted: false, position: 2 }, "dave ne double pas carol");
  assert.deepEqual(await admitJob("carol", "algo", 1), { admitted: true });
});

test("worker mort sans état terminal : sa place se libère d'elle-même quand son battement est périmé", async () => {
  const { admitJob, heartbeatQueuedJob } = await import("../lib/job-queue");
  const { authRun } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  await admitJob("alice", "algo", 1);
  await admitJob("bob", "algo", 1);
  assert.equal((await admitJob("carol", "algo", 1)).admitted, false);
  // alice ne bat plus depuis 6 min (conteneur tué) ; bob bat encore.
  await authRun(`UPDATE job_queue SET heartbeat_at = ? WHERE user_id = ?`, nowStr(-6 * 60_000), "alice");
  await authRun(`UPDATE job_queue SET heartbeat_at = ? WHERE user_id = ?`, nowStr(-6 * 60_000), "bob");
  await heartbeatQueuedJob("bob", "algo", 1);
  assert.deepEqual(await admitJob("carol", "algo", 1), { admitted: true });
  assert.equal((await admitJob("dave", "algo", 1)).admitted, false, "bob compte toujours");
});

test("job remis en file (reprise, arrêt gracieux) : il garde sa place d'origine dans la file", async () => {
  const { admitJob } = await import("../lib/job-queue");
  const { authRun } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  await admitJob("alice", "algo", 1);
  await admitJob("bob", "algo", 1);
  await admitJob("carol", "algo", 1);
  // alice meurt (battement périmé) : son job, repris par la pompe, repasse devant carol.
  await authRun(`UPDATE job_queue SET heartbeat_at = ?, enqueued_at = ? WHERE user_id = ?`, nowStr(-6 * 60_000), nowStr(-60 * 60_000), "alice");
  assert.deepEqual(await admitJob("alice", "algo", 1), { admitted: true });
  assert.deepEqual(await admitJob("carol", "algo", 1), { admitted: false, position: 1 });
});

test("sans plafond (MAX_GLOBAL_JOBS=unlimited, ou dev sans garde-fous) : tout démarre, rien n'est écrit", async () => {
  const { admitJob } = await import("../lib/job-queue");
  const { authGet } = await import("../db/auth-store");
  process.env.MAX_GLOBAL_JOBS = "unlimited";
  for (const u of ["a", "b", "c", "d"]) assert.deepEqual(await admitJob(u, "algo", 1), { admitted: true });
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM job_queue`))?.n, 0);
});

test("startWorker plafond atteint : le job reste en file, l'étudiant voit sa place, et la réconciliation ne le tue pas", async () => {
  const jobs = await import("../lib/jobs");
  const { admitJob } = await import("../lib/job-queue");
  const { q, nowStr } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  await admitJob("alice", "algo", 1);
  await admitJob("bob", "algo", 1);
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    const id = await q.insert(`INSERT INTO jobs (type, target, status, current_step, progress) VALUES ('exam', NULL, 'queued', 'En file…', 0)`);
    await jobs.startWorker(id, "algo");
    const row = await q.get<{ status: string; pid: number | null; current_step: string; worker_id: string | null }>(`SELECT status, pid, current_step, worker_id FROM jobs WHERE id = ?`, id);
    assert.equal(row?.status, "queued");
    assert.equal(row?.pid, null, "aucun worker lancé");
    assert.match(row!.current_step, /file d'attente/i);
    assert.match(row!.current_step, /1/);
    // 3 min plus tard, toujours sans PID : pas un « spawn raté », il attend son tour.
    await q.run(`UPDATE jobs SET updated_at = ?, created_at = ? WHERE id = ?`, nowStr(-180_000), nowStr(-180_000), id);
    await jobs.reconcileStaleJobs();
    assert.equal((await q.get<{ status: string }>(`SELECT status FROM jobs WHERE id = ?`, id))?.status, "queued");
  });
});

test("file d'attente après une reprise : un lecteur anglais lit sa place, pas l'ancienne reprise", async () => {
  const jobs = await import("../lib/jobs");
  const { localizeJob } = await import("../lib/i18n/job-text");
  const { admitJob } = await import("../lib/job-queue");
  const { q } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  await admitJob("alice", "algo", 1);
  await admitJob("bob", "algo", 1);
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    // Reprise posée par la réconciliation (lib/jobs reconcileStaleJobs), puis remise en file pleine.
    const id = await q.insert(`INSERT INTO jobs (type, target, status, current_step, progress, step_json) VALUES ('exam', NULL, 'queued', 'Worker interrompu, reprise automatique (tentative 2/2), progression conservée.', 40, '{"key":"resumed","attempt":2,"max":2}')`);
    await jobs.startWorker(id, "algo");
    const job = (await jobs.getJob(id))!;
    assert.match(job.currentStep ?? "", /file d'attente \(position 1\)/);
    assert.equal(localizeJob(job, null, "en").currentStep, "In line (position 1): the server is at full capacity; your generation starts as soon as a slot frees up.");
  });
});

test("distribution : un job en tête de file déjà terminé (annulé) est retiré, il ne bloque pas les suivants", async () => {
  const jobs = await import("../lib/jobs");
  const { admitJob, dispatchQueue, releaseJob } = await import("../lib/job-queue");
  const { q } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  const { authAll } = await import("../db/auth-store");
  await admitJob("alice", "algo", 1);
  await admitJob("bob", "algo", 1);
  let canceled = 0;
  let queued = 0;
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    canceled = await q.insert(`INSERT INTO jobs (type, target, status, current_step, progress) VALUES ('exam', NULL, 'canceled', 'Annulé', 0)`);
    queued = await q.insert(`INSERT INTO jobs (type, target, status, current_step, progress) VALUES ('exam', NULL, 'queued', 'En file…', 0)`);
  });
  await admitJob("owner", "algo", canceled);
  await admitJob("owner", "algo", queued);
  await releaseJob("alice", "algo", 1);
  const started: QueueEntry[] = [];
  await dispatchQueue(async (e) => { started.push(e); });
  const left = await authAll<{ job_id: number }>(`SELECT job_id FROM job_queue WHERE state = 'waiting'`);
  assert.ok(!left.some((r) => Number(r.job_id) === canceled), "l'entrée du job annulé est retirée");
  assert.deepEqual(started, [{ user: "owner", course: "algo", jobId: queued }]);
});

test("job terminé : sa place est rendue (setJob terminal)", async () => {
  const jobs = await import("../lib/jobs");
  const { admitJob } = await import("../lib/job-queue");
  const { q } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    const id = await q.insert(`INSERT INTO jobs (type, target, status, current_step, progress) VALUES ('exam', NULL, 'running', 'Génération…', 10)`);
    await admitJob("owner", "algo", id);
    await admitJob("bob", "algo", 1);
    assert.equal((await admitJob("carol", "algo", 1)).admitted, false);
    await jobs.setJob(id, { status: "done", progress: 100 });
  });
  assert.deepEqual(await admitJob("carol", "algo", 1), { admitted: true });
});

test("startWorker sur un job déjà terminé : aucune place n'est prise (pas de ligne « en cours » orpheline)", async () => {
  const jobs = await import("../lib/jobs");
  const { authAll } = await import("../db/auth-store");
  const { q } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  let id = 0;
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    id = await q.insert(`INSERT INTO jobs (type, target, status, current_step, progress) VALUES ('exam', NULL, 'done', 'Terminé', 100)`);
    await jobs.startWorker(id, "algo");
  });
  const rows = await authAll<{ job_id: number }>(`SELECT job_id FROM job_queue`);
  assert.ok(!rows.some((r) => Number(r.job_id) === id), "la place du job terminé est rendue");
});

test("une entrée « en cours » dont le battement est vieux de plus de 48 h est purgée", async () => {
  const { admitJob } = await import("../lib/job-queue");
  const { authAll, authRun } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  await admitJob("alice", "algo", 1);
  await authRun(`UPDATE job_queue SET heartbeat_at = ?, enqueued_at = ? WHERE user_id = ?`, nowStr(-49 * 3_600_000), nowStr(-49 * 3_600_000), "alice");
  await admitJob("bob", "algo", 1);
  assert.deepEqual((await authAll<{ user_id: string }>(`SELECT user_id FROM job_queue`)).map((r) => r.user_id), ["bob"]);
});
