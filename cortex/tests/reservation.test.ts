/**
 * B7 + I6 + I5 + I8 bis — RÉSERVATION ATOMIQUE. Postgres réel (PGlite) : le
 * solde, le quota du jour et le nombre de générations en cours sont décidés et
 * enregistrés dans UNE transaction verrouillée par utilisateur. N demandes
 * parallèles avec de quoi payer UNE génération → exactement une passe. Une
 * réservation refusée → le job n'est jamais démarré.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "2";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { q } from "../db/q";

const N = 8;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
});

test("B7 — solde pour UN examen, 8 réservations parallèles → exactement 1 acceptée, solde jamais négatif", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const user = "usr_parallel";
  assert.equal(await credits.getBalanceCenti(user), 200); // 2 crédits offerts = 1 examen
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      runWithUser(user, () => runWithCourse("ml", () =>
        reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:ml:${i + 1}` })
      ))
    )
  );
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 1, `réservations acceptées : ${ok.length}/${N}`);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.status === 402), "les refus sont des 402");
  assert.equal(await credits.getBalanceCenti(user), 0);
});

test("I6 — quota du jour = 1, 5 demandes parallèles → exactement 1 comptée", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const guards = await import("../lib/billing/guards");
  process.env.DAILY_GEN_QUOTA = "1";
  process.env.SIGNUP_FREE_CREDITS = "50";
  try {
    const user = "usr_quota";
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        runWithUser(user, () => runWithCourse("ml", () =>
          reserveGeneration({ bucket: "gen", kind: "qcm", ref: `job:${user}:ml:${i + 1}` })
        ))
      )
    );
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.status === 429));
    assert.equal(await guards.usedToday("gen", user), 1);
  } finally {
    process.env.DAILY_GEN_QUOTA = "unlimited";
    process.env.SIGNUP_FREE_CREDITS = "2";
  }
});

test("I5 — au plus MAX_ACTIVE_JOBS générations en cours par compte, tous cours confondus, hors facturation", async () => {
  const { reserveGeneration, releaseJobSlot } = await import("../lib/billing/reserve");
  process.env.MAX_ACTIVE_JOBS = "2";
  process.env.BILLING_ENABLED = "0";
  try {
    const user = "usr_slots";
    const courses = ["ml", "algo", "cs-202", "ml", "algo"];
    const results = await Promise.all(
      courses.map((c, i) =>
        runWithUser(user, () => runWithCourse(c, () =>
          reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:${c}:${i + 1}`, jobSlot: { course: c, jobId: i + 1 } })
        ))
      )
    );
    assert.equal(results.filter((r) => r.ok).length, 2, JSON.stringify(results));
    // Un job terminé libère sa place.
    await releaseJobSlot(user, "ml", 1);
    await releaseJobSlot(user, "algo", 2);
    await releaseJobSlot(user, "cs-202", 3);
    const again = await runWithUser(user, () => runWithCourse("ml", () =>
      reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:ml:9`, jobSlot: { course: "ml", jobId: 9 } })
    ));
    assert.equal(again.ok, true);
  } finally {
    process.env.MAX_ACTIVE_JOBS = "unlimited";
    process.env.BILLING_ENABLED = "1";
  }
});

test("I8 bis — réservation refusée : le job est marqué en erreur et startWorker ne lance RIEN", async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const user = "usr_fauche";
  await runWithUser(user, () => runWithCourse("algo", async () => {
    // Vide le solde offert.
    await credits.addTransaction(user, -200, "test", `test:${user}:vide`);
    await assert.rejects(
      () => jobs.createJobExclusive("exam"),
      (e: Error & { status?: number }) => e instanceof jobs.ReservationRefused && e.status === 402,
    );
    const row = await q.get<{ id: number; status: string; pid: number | null }>(`SELECT id, status, pid FROM jobs ORDER BY id DESC LIMIT 1`);
    assert.ok(row, "le job doit exister pour porter le motif du refus");
    assert.equal(row!.status, "error");
    await jobs.startWorker(row!.id, "algo");
    const after = await q.get<{ pid: number | null; status: string }>(`SELECT pid, status FROM jobs WHERE id = ?`, row!.id);
    assert.equal(after!.pid, null, "un worker a été lancé pour un job refusé");
    assert.equal(after!.status, "error");
    assert.equal(await credits.getBalanceCenti(user), 0, "rien débité");
  }));
});

test("B7 — l'ancien débit non conditionnel n'existe plus (aucun chemin de débit hors réservation)", async () => {
  const credits = await import("../lib/billing/credits") as Record<string, unknown>;
  assert.equal(typeof credits.debitGeneration, "undefined", "debitGeneration doit disparaître au profit de reserveGeneration");
});
