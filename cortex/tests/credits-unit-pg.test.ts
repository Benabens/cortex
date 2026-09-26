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

test("2b-7 : une ligne écrite par l'ANCIEN code après la migration (unit NULL, crédits entiers) est lue en centièmes, puis convertie une seule fois", async () => {
  const { authRun, authAll, authGet } = await import("../db/auth-store");
  const credits = await import("../lib/billing/credits");
  // Marqueur déjà posé (test précédent) et drapeau mémoire levé : c'est le
  // déploiement glissant — l'ancienne instance écrit encore en crédits entiers.
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, "carol", 3, "achat ancien code", "old:1", "2026-09-03 10:00:00");
  assert.equal(await credits.getBalanceCenti("carol"), 300 + 200, "lecture : NULL = crédits entiers ×100 (+ palier gratuit)");
  // Deux instances redémarrent en même temps : conversion par ligne, une seule fois.
  credits.resetLedgerUnitCheck();
  await Promise.all([credits.ensureLedgerUnit(), credits.ensureLedgerUnit()]);
  const rows = await authAll<{ delta: number; unit: string | null }>(`SELECT delta, unit FROM credit_transactions WHERE ref = ?`, "old:1");
  assert.deepEqual(rows.map((r) => [Number(r.delta), r.unit]), [[300, "centi"]]);
  assert.equal(await credits.getBalanceCenti("carol"), 500);
  // Les lignes déjà converties par la migration initiale portent l'unité.
  const alice = await authAll<{ unit: string | null }>(`SELECT unit FROM credit_transactions WHERE user_id = ?`, "alice");
  assert.ok(alice.length >= 3 && alice.every((r) => r.unit === "centi"));
  // Nouvelles écritures : unité explicite ; historique lu en centièmes.
  await credits.addTransaction("carol", 30, "test", "new:1");
  const row = await authGet<{ delta: number; unit: string }>(`SELECT delta, unit FROM credit_transactions WHERE ref = ?`, "new:1");
  assert.deepEqual([Number(row!.delta), row!.unit], [30, "centi"]);
  assert.equal(await credits.getBalanceCenti("carol"), 530);
  assert.deepEqual((await credits.listTransactions("carol")).map((t) => Number(t.delta)), [30, 200, 300], "historique en centièmes (palier gratuit écrit à la première lecture)");
});

test("4b-6 : credit_transactions.ref est UNIQUE en Postgres (index), garanti par la migration", async () => {
  const { authAll } = await import("../db/auth-store");
  const idx = await authAll<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'credit_transactions'`);
  assert.ok(idx.some((i) => /UNIQUE/i.test(i.indexdef) && /\(ref\)/.test(i.indexdef)), idx.map((i) => i.indexdef).join("\n"));
  const { ensureCreditRefUnique } = await import("../db/auth-store");
  assert.equal(await ensureCreditRefUnique(), "present");
});
