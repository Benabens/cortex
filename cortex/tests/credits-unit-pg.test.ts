/** B5 (unité) — même migration du ledger en centièmes, sur Postgres réel (PGlite). */
import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "2";

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS"]) delete process.env[k];
});

test("postgres : conversion ×100 en une instruction, idempotente, soldes affichés inchangés", async () => {
  const { authRun, authAll } = await import("../db/auth-store");
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, "alice", 2, "signup", "signup:alice", "2026-08-30 10:00:00");
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, "alice", 5, "achat", "evt_1", "2026-09-01 10:00:00");
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, "alice", -2, "génération exam", "job:alice:ml:1", "2026-09-02 10:00:00");
  const credits = await import("../lib/billing/credits");
  await credits.ensureLedgerUnit();
  credits.resetLedgerUnitCheck();
  await credits.ensureLedgerUnit(); // rejeu (autre process) : rien ne bouge
  const rows = await authAll<{ delta: number }>(`SELECT delta FROM credit_transactions WHERE user_id = ? ORDER BY id`, "alice");
  assert.deepEqual(rows.map((r) => Number(r.delta)), [200, 500, -200]);
  assert.equal(await credits.getBalance("alice"), 5);
  assert.equal(await credits.getBalanceCenti("bob"), 200);
});
