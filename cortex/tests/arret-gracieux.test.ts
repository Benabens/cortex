/**
 * ARRÊT GRACIEUX — constat prod du 14-15/11/2026 : chaque redéploiement Railway tuait les jobs en
 * cours (job 20 perdu à 99 %, jobs 23 et 25 refaits de zéro). Sur SIGTERM, le serveur ne prend
 * plus de job, laisse finir ceux qu'il a lancés, et à l'échéance remet les survivants en file
 * pour le conteneur suivant. Le SIGTERM est simulé (process.emit) ; les workers sont de vrais
 * process enfants détachés, comme ceux de startWorker.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { nowStr, q } from "../db/q";

const COURSE = "ml";
const USER = "owner";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
beforeEach(async () => {
  (await import("../lib/drain")).resetDrainForTests();
});
after(async () => {
  (await import("../lib/drain")).resetDrainForTests();
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

const inTenant = <T,>(fn: () => Promise<T>) => runWithUser(USER, () => runWithCourse(COURSE, fn));

/** Un « worker » : process détaché qui vit `ms` millisecondes, suivi comme ceux de startWorker. */
async function fakeWorker(jobId: number, ms: number) {
  const { trackWorker } = await import("../lib/drain");
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { detached: true, stdio: "ignore" });
  trackWorker(child, { jobId, user: USER, course: COURSE });
  const exited = new Promise<number>((resolve) => child.once("exit", () => resolve(Date.now())));
  return { child, exited };
}

async function runningJob(attempts: number) {
  const jobs = await import("../lib/jobs");
  return inTenant(async () => {
    await jobs.ensureJobsSchema();
    const id = await jobs.createJob("qcm");
    await q.run(`UPDATE jobs SET status = 'running', worker_id = 'spawn', attempts = ?, heartbeat_at = ?, progress = 99 WHERE id = ?`, attempts, nowStr(), id);
    return id;
  });
}

const row = (id: number) => inTenant(() => q.get<{ status: string; pid: number | null; worker_id: string | null; attempts: number; current_step: string | null }>(
  `SELECT status, pid, worker_id, attempts, current_step FROM jobs WHERE id = ?`, id,
));

function install(budgetMs: number) {
  return import("../lib/drain").then(({ installGracefulShutdown }) => {
    const handedOff: number[] = [];
    let exitAt = 0;
    const exited = new Promise<number>((resolve) => {
      installGracefulShutdown({
        budgetMs: () => budgetMs,
        log: () => {},
        handOff: async (workers) => {
          handedOff.push(...workers.map((w) => w.jobId));
          await (await import("../lib/jobs")).handOffJobs(workers);
        },
        exit: (code) => { exitAt = Date.now(); resolve(code); },
      });
    });
    return { handedOff, exited, exitAt: () => exitAt };
  });
}

test("SIGTERM pendant un job : le job en cours finit, aucun nouveau job n'est pris, puis le serveur sort", async () => {
  const jobs = await import("../lib/jobs");
  const { isDraining, runningWorkers } = await import("../lib/drain");
  const running = await runningJob(0);
  const worker = await fakeWorker(running, 800);
  await inTenant(() => q.run(`UPDATE jobs SET pid = ? WHERE id = ?`, worker.child.pid ?? null, running));
  const shutdown = await install(30_000);

  process.emit("SIGTERM");
  assert.ok(isDraining(), "le drain commence au SIGTERM");

  // Un job créé pendant le drain (réservation faite par la route) n'est PAS démarré ici : il reste
  // en file, différé, pour le conteneur suivant.
  const fresh = await inTenant(async () => {
    const id = await jobs.createJob("qcm");
    await jobs.startWorker(id, COURSE);
    return id;
  });
  assert.equal(runningWorkers().length, 1, "aucun worker lancé pendant le drain");
  const deferred = await row(fresh);
  assert.equal(deferred?.status, "queued");
  assert.equal(deferred?.pid, null);
  assert.equal(deferred?.worker_id, "deferred");
  assert.match(deferred?.current_step ?? "", /quelques minutes/);
  // La pompe ne relance rien non plus : un job repris maintenant mourrait avec le conteneur.
  assert.equal(await inTenant(() => jobs.pumpQueuedJobs()), 0);

  const code = await shutdown.exited;
  const workerEnd = await worker.exited;
  assert.equal(code, 0);
  assert.ok(shutdown.exitAt() >= workerEnd, "le serveur sort APRÈS la fin du job en cours");
  assert.deepEqual(shutdown.handedOff, [], "un job fini dans le délai n'est pas remis en file");
  assert.equal((await row(running))?.status, "running", "le job fini n'est pas touché par le drain (son worker l'aurait clos)");
});

test("conteneur suivant : un job différé est démarrable, et la réconciliation ne le prend pas pour un spawn raté", async () => {
  const jobs = await import("../lib/jobs");
  await install(30_000);
  process.emit("SIGTERM");
  const id = await inTenant(async () => {
    const id = await jobs.createJob("qcm");
    await jobs.startWorker(id, COURSE);
    return id;
  });
  (await import("../lib/drain")).resetDrainForTests(); // nouveau process
  // Le nouveau conteneur démarre plusieurs minutes plus tard : sans le marqueur, plus de 120 s
  // sans PID ni tentative = « jamais démarré » → erreur et remboursement.
  await inTenant(() => q.run(`UPDATE jobs SET updated_at = ?, created_at = ? WHERE id = ?`, "2026-11-15 00:00:00", "2026-11-15 00:00:00", id));
  await inTenant(() => jobs.reconcileStaleJobs());
  assert.equal((await row(id))?.status, "queued", "un job différé reste en file");
  assert.ok(await inTenant(() => jobs.claimJobStart(id)), "la pompe du conteneur suivant peut le démarrer");
  assert.equal((await row(id))?.worker_id, "spawn");
});

test("échéance du drain : le job encore en cours est arrêté et remis en file, différé, sans tentative consommée", async () => {
  const id = await runningJob(1);
  const worker = await fakeWorker(id, 60_000);
  await inTenant(() => q.run(`UPDATE jobs SET pid = ? WHERE id = ?`, worker.child.pid ?? null, id));
  const shutdown = await install(300);
  const t0 = Date.now();
  process.emit("SIGTERM");
  assert.equal(await shutdown.exited, 0);
  assert.ok(Date.now() - t0 < 10_000, "le serveur n'attend pas au-delà de l'échéance");
  assert.deepEqual(shutdown.handedOff, [id]);
  await worker.exited; // arrêté par la remise en file, pas laissé au SIGKILL
  const r = await row(id);
  assert.equal(r?.status, "queued");
  assert.equal(r?.pid, null);
  assert.equal(r?.worker_id, "deferred");
  assert.equal(r?.attempts, 1, "un déploiement n'est pas un échec : la tentative n'est pas consommée");
  assert.match(r?.current_step ?? "", /progression conservée/);
});

test("aucun job en cours : le serveur sort tout de suite", async () => {
  const shutdown = await install(30_000);
  const t0 = Date.now();
  process.emit("SIGTERM");
  assert.equal(await shutdown.exited, 0);
  assert.ok(Date.now() - t0 < 1_000);
  assert.deepEqual(shutdown.handedOff, []);
});

test("un second signal sort sans attendre la fin du drain", async () => {
  const id = await runningJob(0);
  const worker = await fakeWorker(id, 5_000);
  const codes: number[] = [];
  const { installGracefulShutdown } = await import("../lib/drain");
  installGracefulShutdown({ budgetMs: () => 30_000, log: () => {}, handOff: async () => {}, exit: (c) => { codes.push(c); } });
  process.emit("SIGTERM");
  process.emit("SIGINT");
  assert.deepEqual(codes, [0], "sortie immédiate au second signal");
  worker.child.kill("SIGKILL");
  await worker.exited;
});

test("délai du drain : celui de Railway, moins la marge de remise en file", async () => {
  const { drainBudgetMs } = await import("../lib/drain");
  assert.equal(drainBudgetMs({}), 0, "sans variable, Railway tue aussitôt : remise en file immédiate");
  assert.equal(drainBudgetMs({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "1800" }), 1_740_000);
  assert.equal(drainBudgetMs({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "120" }), 90_000, "un délai court garde l'essentiel pour finir");
  assert.equal(drainBudgetMs({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "1800", CORTEX_DRAIN_SECONDS: "10" }), 10_000);
});
