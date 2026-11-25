process.env.CREDITS_COST_JSON = JSON.stringify({ exam: 6, qcm: 4, exercise: 1, "lab-exercise": 1, blueprint: 1, format: 1, prepare: 2, assist: 0.3 });

/**
 * REPRISE APRÈS REDÉMARRAGE ET MODE PROPRIÉTAIRE — un job du propriétaire n'a
 * pas de réservation débitée (reserveGeneration ne l'écrit pas, cf.
 * lib/billing/owner) : interrompu par un redéploiement, il doit pourtant être
 * remis en file, et son worker repris doit passer la garde centrale du LLM.
 * Pour tout autre compte, la garde du paywall reste entière : sans réservation
 * valide, aucune reprise.
 * Postgres réel (PGlite), facturation active.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.CORTEX_OWNER_EMAIL = "Ben@Example.com";
delete process.env.CORTEX_OWNER_USER_ID;

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

const OWNER = "usr_owner_resume";
const OTHER = "usr_other_resume";
const DEAD_PID = 999_999;
const ENV_KEYS = ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "CORTEX_OWNER_EMAIL"];

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, OWNER, "ben@example.com", "Ben");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, OTHER, "alice@example.com", "Alice");
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ENV_KEYS) delete process.env[k];
});

const as = <T>(user: string, fn: () => Promise<T>) => runWithUser(user, () => runWithCourse("ml", fn));

/** Le conteneur redémarre en pleine génération : le worker est mort, le job reste « running ». */
async function killWorker(id: number): Promise<void> {
  const { q } = await import("../db/q");
  await q.run(`UPDATE jobs SET status = 'running', pid = ?, worker_id = 'spawn', progress = 99 WHERE id = ?`, DEAD_PID, id);
}

async function jobRow(id: number) {
  const { q } = await import("../db/q");
  return q.get<{ status: string; attempts: number | null; error: string | null; credit_ref: string | null }>(
    `SELECT status, attempts, error, credit_ref FROM jobs WHERE id = ?`, id,
  );
}

let ownerJobId = 0;

test("propriétaire : un job interrompu par un redémarrage est remis en file, pas mis en erreur", async () => {
  const jobs = await import("../lib/jobs");
  await as(OWNER, async () => {
    const { id, existing } = await jobs.createJobExclusive("exam");
    assert.equal(existing, false);
    ownerJobId = id;
    await killWorker(id);
    await jobs.reconcileStaleJobs();
    const row = await jobRow(id);
    assert.equal(row?.status, "queued", JSON.stringify(row));
    assert.equal(row?.attempts, 1);
  });
});

test("propriétaire : un job dont la référence a été émise pour un autre compte n'est pas exempté", async () => {
  // Une base partagée entre comptes (SQLite : une base par cours) ferait
  // réconcilier sous l'identité du propriétaire les jobs des autres comptes.
  const jobs = await import("../lib/jobs");
  const { q } = await import("../db/q");
  await as(OWNER, async () => {
    const id = await q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, credit_ref) VALUES ('exam', NULL, 'queued', 'En file…', 0, ?)`,
      `job:${OTHER}:ml:${crypto.randomUUID()}`,
    );
    await killWorker(id);
    await jobs.reconcileStaleJobs();
    const row = await jobRow(id);
    assert.equal(row?.status, "error", JSON.stringify(row));
    assert.match(row?.error ?? "", /réservation de crédits est absente/);
  });
});

test("autre compte : un job interrompu sans réservation valide n'est jamais repris", async () => {
  const jobs = await import("../lib/jobs");
  const { q } = await import("../db/q");
  await as(OTHER, async () => {
    await jobs.ensureJobsSchema();
    const id = await q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, credit_ref) VALUES ('exam', NULL, 'queued', 'En file…', 0, ?)`,
      `job:${OTHER}:ml:sans-debit`,
    );
    await killWorker(id);
    await jobs.reconcileStaleJobs();
    const row = await jobRow(id);
    assert.equal(row?.status, "error", JSON.stringify(row));
    assert.match(row?.error ?? "", /réservation de crédits est absente/);
  });
});

test("autre compte : un job interrompu avec une réservation débitée est remis en file", async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  await credits.addTransaction(OTHER, 1000, "test", "test:other-resume-topup");
  await as(OTHER, async () => {
    const { id } = await jobs.createJobExclusive("exam");
    await killWorker(id);
    await jobs.reconcileStaleJobs();
    assert.equal((await jobRow(id))?.status, "queued");
  });
});

test("worker repris : la garde centrale du LLM laisse passer le job du propriétaire et arrête l'autre compte", async () => {
  const { assertLlmAuthorized } = await import("../lib/llm/authorization");
  const { setCurrentJob, clearCurrentJob } = await import("../lib/billing/usage-context");
  const testAuth = process.env.CORTEX_LLM_TEST_AUTH;
  delete process.env.CORTEX_LLM_TEST_AUTH;
  // Comme scripts/run-job.ts : l'utilisateur vient de CORTEX_USER (posé par
  // startWorker depuis la pompe), la preuve de paiement du credit_ref du job.
  const asWorker = async (user: string, creditRef: string | null) => {
    process.env.CORTEX_USER = user;
    setCurrentJob(1, "exam", creditRef);
    return assertLlmAuthorized();
  };
  try {
    const ownerRef = (await as(OWNER, async () => (await jobRow(ownerJobId))?.credit_ref)) ?? null;
    assert.ok(ownerRef?.startsWith(`job:${OWNER}:`), "le job du propriétaire porte une référence sans débit");
    await asWorker(OWNER, ownerRef);
    await assert.rejects(
      () => asWorker(OTHER, `job:${OTHER}:ml:sans-debit`),
      (e: Error & { code?: string }) => e.code === "PAYMENT_REQUIRED",
    );
    await assert.rejects(
      () => asWorker(OTHER, ownerRef),
      (e: Error & { code?: string }) => e.code === "PAYMENT_REQUIRED",
      "la référence du propriétaire ne vaut rien pour un autre compte",
    );
  } finally {
    clearCurrentJob();
    delete process.env.CORTEX_USER;
    if (testAuth) process.env.CORTEX_LLM_TEST_AUTH = testAuth;
  }
});
