/**
 * B5 (unité) — le ledger passe en CENTI-CRÉDITS pour facturer l'assistance en
 * fraction de crédit sans casser les soldes existants : une base héritée (deltas
 * en crédits entiers) est migrée UNE fois, atomiquement, ×100 ; les soldes
 * affichés ne changent pas ; les coûts internes sont en centièmes.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-centi-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "2";
delete process.env.CREDITS_COST_JSON;

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "CREDITS_COST_JSON"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("migration : un ledger hérité (crédits entiers) est converti ×100 une seule fois, soldes identiques", async () => {
  const { authRun, authAll } = await import("../db/auth-store");
  // Base « de prod » : lignes écrites par l'ancien code, en crédits entiers, sans marqueur d'unité.
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, "alice", 2, "signup", "signup:alice", "2026-09-01 10:00:00");
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, "alice", 5, "achat pack medium", "evt_legacy_1", "2026-09-02 10:00:00");
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, "alice", -2, "génération exam", "job:alice:ml:1", "2026-09-03 10:00:00");

  const credits = await import("../lib/billing/credits");
  await credits.ensureLedgerUnit();
  const rows = await authAll<{ delta: number }>(`SELECT delta FROM credit_transactions WHERE user_id = ? ORDER BY id`, "alice");
  assert.deepEqual(rows.map((r) => Number(r.delta)), [200, 500, -200]);
  assert.equal(await credits.getBalanceCenti("alice"), 500);
  assert.equal(await credits.getBalance("alice"), 5); // affiché en crédits, inchangé pour l'utilisateur

  // Rejouée (second process, redémarrage) : aucune double conversion.
  await credits.ensureLedgerUnit();
  const again = await authAll<{ delta: number }>(`SELECT delta FROM credit_transactions WHERE user_id = ? ORDER BY id`, "alice");
  assert.deepEqual(again.map((r) => Number(r.delta)), [200, 500, -200]);
  const meta = await authAll<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, "credits_unit");
  assert.equal(meta[0]?.value, "centi");
});

test("nouvelles écritures en centièmes : palier gratuit, coûts, débit, remboursement", async () => {
  const credits = await import("../lib/billing/credits");
  assert.equal(await credits.getBalanceCenti("bob"), 200); // 2 crédits offerts = 200 centièmes
  assert.equal(credits.creditCost("exam"), 200);
  assert.equal(credits.creditCost("qcm"), 100);
  assert.equal(credits.creditCost("assist"), 10); // 0,1 crédit : l'assistance n'est plus gratuite
  process.env.CREDITS_COST_JSON = JSON.stringify({ assist: 0.25, exam: 3 });
  assert.equal(credits.creditCost("assist"), 25);
  assert.equal(credits.creditCost("exam"), 300);
  delete process.env.CREDITS_COST_JSON;

  const { runWithUser } = await import("../db/context");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  await runWithUser("bob", () => reserveGeneration({ bucket: "gen", kind: "qcm", ref: "job:bob:ml:1" }));
  assert.equal(await credits.getBalanceCenti("bob"), 100);
  assert.equal(await credits.getBalance("bob"), 1);
  await runWithUser("bob", () => credits.refundGeneration("qcm", "job:bob:ml:1"));
  assert.equal(await credits.getBalanceCenti("bob"), 200);
  // Les gates raisonnent en centièmes : 1,9 crédit ne suffit pas pour un examen à 2.
  await runWithUser("bob", () => reserveGeneration({ bucket: "assist", kind: "assist", ref: "assist:bob:1" }));
  assert.equal(await credits.getBalance("bob"), 1.9);
  const gate = await runWithUser("bob", () => credits.creditsGate("exam"));
  assert.ok(gate && gate.status === 402 && /1,9/.test(gate.error), gate?.error);
});
