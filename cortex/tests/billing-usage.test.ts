/**
 * Billing — tests hermétiques, sans réseau ni LLM :
 *  - mapping économe : « opus » → Sonnet sur le provider anthropic sauf opt-in ;
 *  - estimation de coût par modèle (tarifs publics corrigés 09/2026, Sonnet 2/10) ;
 *  - recordUsage n'écrit pas pour claude-code (dev €0) et écrit pour anthropic ;
 *  - kill-switch SPEND_CAP_USD : coupe au plafond (code SPEND_CAP), jamais claude-code.
 *
 * Le store auth (llm_usage) est relogé dans un dossier jetable via CORTEX_DATA_DIR.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-billing-"));
process.env.CORTEX_DATA_DIR = tmp; // AVANT tout import des modules db/lib (DATA figé au chargement)

// Imports DYNAMIQUES dans before() : lib/courses fige dataRoot() au chargement
// du module — un import statique serait hoisté au-dessus de l'env ci-dessus.
let mapModel: typeof import("../lib/llm/config").mapModel;
let billing: typeof import("../lib/billing/usage");
let authAll: typeof import("../db/auth-store").authAll;

before(async () => {
  delete process.env.LLM_ALLOW_OPUS;
  delete process.env.LLM_MODEL_OPUS;
  delete process.env.SPEND_CAP_USD;
  ({ mapModel } = await import("../lib/llm/config"));
  billing = await import("../lib/billing/usage");
  ({ authAll } = await import("../db/auth-store"));
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.SPEND_CAP_USD;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("mapping économe : opus → Sonnet par défaut sur anthropic ; Opus si LLM_ALLOW_OPUS=1 ; claude-code intact", () => {
  assert.equal(mapModel("opus", "anthropic"), "claude-sonnet-5");
  process.env.LLM_ALLOW_OPUS = "1";
  assert.equal(mapModel("opus", "anthropic"), "claude-opus-4-8");
  delete process.env.LLM_ALLOW_OPUS;
  // LLM_MODEL_OPUS explicite prime toujours (mapping choisi par l'opérateur)
  process.env.LLM_MODEL_OPUS = "claude-haiku-4-5-20251001";
  assert.equal(mapModel("opus", "anthropic"), "claude-haiku-4-5-20251001");
  delete process.env.LLM_MODEL_OPUS;
  // dev €0 : passthrough historique du CLI
  assert.equal(mapModel("opus", "claude-code"), "opus");
  assert.equal(mapModel("sonnet", "anthropic"), "claude-sonnet-5");
  assert.equal(mapModel("haiku", "anthropic"), "claude-haiku-4-5-20251001");
});

test("estimateCostUsd : tarifs par préfixe, inconnu → tarif conservateur (opus)", () => {
  // sonnet 5 : 2 $/MTok in + 10 $/MTok out (tarif public corrigé 09/2026)
  assert.ok(Math.abs(billing.estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000) - 12) < 1e-9);
  // opus : 5 + 25
  assert.ok(Math.abs(billing.estimateCostUsd("claude-opus-4-8", 1_000_000, 1_000_000) - 30) < 1e-9);
  // haiku : 1 + 5
  assert.ok(Math.abs(billing.estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000) - 6) < 1e-9);
  // inconnu → surestimation volontaire (tarif opus)
  assert.ok(Math.abs(billing.estimateCostUsd("mystere-9000", 1_000_000, 0) - 5) < 1e-9);
  // tokens absents → 0, jamais NaN
  assert.equal(billing.estimateCostUsd("claude-sonnet-5"), 0);
});

test("recordUsage : claude-code (€0) n'écrit RIEN ; anthropic écrit coût + user + cours", async () => {
  await billing.recordUsage({ provider: "claude-code", model: "opus", tokensIn: 1000, tokensOut: 1000 });
  let rows = await authAll<{ n: number }>("SELECT count(*) n FROM llm_usage");
  assert.equal(Number(rows[0].n), 0);

  await billing.recordUsage({ provider: "anthropic", model: "claude-sonnet-5", tokensIn: 200_000, tokensOut: 100_000 });
  rows = await authAll<{ n: number }>("SELECT count(*) n FROM llm_usage");
  assert.equal(Number(rows[0].n), 1);
  const row = (await authAll<{ user_id: string; course: string; cost_usd: number }>(
    "SELECT user_id, course, cost_usd FROM llm_usage"
  ))[0];
  assert.equal(row.user_id, "owner");
  assert.equal(row.course, "cs-202");
  // 0,2 MTok × 2 + 0,1 MTok × 10 = 1,4 $ (Sonnet 5 corrigé 2/10)
  assert.ok(Math.abs(Number(row.cost_usd) - 1.4) < 1e-9);
});

test("kill-switch : sous le plafond → passe ; plafond atteint → LlmError SPEND_CAP ; claude-code jamais bloqué", async () => {
  billing.resetSpendCache();
  // dépense courante : 1,4 $ (test précédent)
  process.env.SPEND_CAP_USD = "10";
  await billing.assertSpendCap("anthropic"); // ne jette pas

  process.env.SPEND_CAP_USD = "1";
  billing.resetSpendCache();
  await assert.rejects(
    () => billing.assertSpendCap("anthropic"),
    (e: Error & { code?: string }) => e.code === "SPEND_CAP" && /Plafond de dépense/.test(e.message),
  );
  // le dev €0 n'est JAMAIS coupé
  await billing.assertSpendCap("claude-code");

  // SPEND_CAP_USD=0 = kill-switch d'URGENCE : tout appel payant coupé
  process.env.SPEND_CAP_USD = "0";
  billing.resetSpendCache();
  await assert.rejects(() => billing.assertSpendCap("anthropic"), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
  await billing.assertSpendCap("claude-code"); // dev €0 toujours intact

  // sans plafond → no-op
  delete process.env.SPEND_CAP_USD;
  billing.resetSpendCache();
  await billing.assertSpendCap("anthropic");
});

test("totalSpendUsd : somme lue en DB (source de vérité cross-process)", async () => {
  billing.resetSpendCache();
  const total = await billing.totalSpendUsd();
  assert.ok(Math.abs(total - 1.4) < 1e-9);
});
