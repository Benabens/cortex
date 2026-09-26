/**
 * Deux trous de course sur les jobs, payés par le propriétaire :
 *  1. la réservation suivait l'insertion du job : un second POST voyait le job
 *     « actif » (existing) pendant que la réservation du premier échouait, et
 *     le démarrait quand même — génération sans débit. Désormais le job n'est
 *     inséré qu'APRÈS une réservation acceptée (un refus ne laisse aucune ligne).
 *  2. deux appels startWorker sur un même job en file lançaient deux workers
 *     (double coût pour un seul paiement) : le démarrage est revendiqué
 *     atomiquement, un seul appelant gagne.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "2";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { q } from "../db/q";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
});

test("réservation refusée → AUCUNE ligne de job (rien à démarrer, rien à voir comme « existing »)", async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const user = "usr_sans_sou";
  await runWithUser(user, () => runWithCourse("ml", async () => {
    await jobs.ensureJobsSchema();
    await credits.addTransaction(user, -200, "test", `test:${user}:vide`);
    const before = Number((await q.get<{ n: number }>(`SELECT count(*) n FROM jobs`))?.n ?? 0);
    await assert.rejects(() => jobs.createJobExclusive("exam"), (e: Error) => e instanceof jobs.ReservationRefused);
    const after = Number((await q.get<{ n: number }>(`SELECT count(*) n FROM jobs`))?.n ?? 0);
    assert.equal(after, before, "un refus ne doit laisser aucun job");
    assert.equal(await credits.getBalanceCenti(user), 0);
  }));
});

test("deux créations simultanées avec de quoi payer UN examen → un seul job, un seul débit", async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const user = "usr_double";
  const results = await runWithUser(user, () => runWithCourse("algo", () =>
    Promise.allSettled([jobs.createJobExclusive("exam"), jobs.createJobExclusive("exam")])
  ));
  const ok = results.filter((r): r is PromiseFulfilledResult<{ id: number; existing: boolean }> => r.status === "fulfilled");
  const ids = new Set(ok.map((r) => r.value.id));
  assert.equal(ids.size, 1, `jobs distincts créés : ${[...ids].join(",")}`);
  assert.equal(await credits.getBalanceCenti(user), 0, "un seul examen débité, pas deux");
  const rows = await runWithUser(user, () => runWithCourse("algo", () => q.all<{ id: number; status: string }>(`SELECT id, status FROM jobs`)));
  assert.equal(rows.length, 1);
});

test("le démarrage d'un job est revendiqué atomiquement : deux prétendants, un seul gagne", async () => {
  const jobs = await import("../lib/jobs");
  const user = "usr_claim";
  process.env.BILLING_ENABLED = "0";
  try {
    await runWithUser(user, () => runWithCourse("cs-202", async () => {
      const { id } = await jobs.createJobExclusive("qcm");
      const wins = await Promise.all([jobs.claimJobStart(id), jobs.claimJobStart(id)]);
      assert.deepEqual(wins.sort(), [false, true]);
      // Un job remis en file (zombie repris) redevient revendicable.
      await q.run(`UPDATE jobs SET status = 'queued', pid = NULL, heartbeat_at = NULL, worker_id = NULL WHERE id = ?`, id);
      assert.equal(await jobs.claimJobStart(id), true);
      // Un job en erreur ne l'est jamais.
      await jobs.setJob(id, { status: "error", error: "x" });
      assert.equal(await jobs.claimJobStart(id), false);
    }));
  } finally { process.env.BILLING_ENABLED = "1"; }
});

test("le remboursement retrouve la référence de réservation portée par le job", async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const user = "usr_refund_ref";
  process.env.SIGNUP_FREE_CREDITS = "4";
  try {
    await runWithUser(user, () => runWithCourse("ml", async () => {
      const { id } = await jobs.createJobExclusive("exam");
      assert.equal(await credits.getBalanceCenti(user), 200);
      const row = await q.get<{ credit_ref: string | null }>(`SELECT credit_ref FROM jobs WHERE id = ?`, id);
      assert.ok(row?.credit_ref, "le job doit porter sa référence de débit");
      await jobs.refundJobCredits({ id, type: "exam" });
      assert.equal(await credits.getBalanceCenti(user), 400);
    }));
  } finally { process.env.SIGNUP_FREE_CREDITS = "2"; }
});
