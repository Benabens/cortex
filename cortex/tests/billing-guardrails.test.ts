/**
 * GARDE-FOUS DE COÛT — chaque test prouve qu'un garde-fou MORD (principe :
 * un garde-fou non testé est un garde-fou qu'on croit avoir).
 *  1. Convention FAIL-CLOSED : défaut en déploiement gardé, levée explicite.
 *  2. Quota quotidien : compte au-delà du cap → 429, un AUTRE compte passe.
 *  3. Limite de débit PAR UTILISATEUR (pas par processus) : compte au-delà → 429.
 *  4. Plafond de dépense PAR UTILISATEUR : compte au-delà → SPEND_CAP, un autre passe.
 *  5. llm_usage écrit pour le provider CLI local quand le suivi est actif (estimated=1).
 *
 * Hermétique : store auth relogé dans un dossier jetable (CORTEX_DATA_DIR).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-guardrails-"));
process.env.CORTEX_DATA_DIR = tmp;

let env: typeof import("../lib/billing/env");
let guards: typeof import("../lib/billing/guards");
let usage: typeof import("../lib/billing/usage");
let ctx: typeof import("../db/context");
let authAll: typeof import("../db/auth-store").authAll;

const GUARD_ENV = [
  "AUTH_ENABLED", "BILLING_ENABLED", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA",
  "RATE_LIMIT_PER_USER_MIN", "SPEND_CAP_USD", "SPEND_CAP_PER_USER_USD", "CORTEX_TRACK_USAGE",
];

before(async () => {
  for (const k of GUARD_ENV) delete process.env[k];
  env = await import("../lib/billing/env");
  guards = await import("../lib/billing/guards");
  usage = await import("../lib/billing/usage");
  ctx = await import("../db/context");
  ({ authAll } = await import("../db/auth-store"));
});

beforeEach(() => {
  for (const k of GUARD_ENV) delete process.env[k];
  usage.resetSpendCache();
});

after(() => {
  for (const k of GUARD_ENV) delete process.env[k];
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("fail-closed : défaut appliqué en déploiement gardé, levée EXPLICITE requise", () => {
  // Dev nu : aucune limite (comportement historique).
  assert.equal(env.intLimit("DAILY_GEN_QUOTA", 10), null);
  // Déploiement gardé : le défaut s'applique même sans variable posée.
  process.env.AUTH_ENABLED = "1";
  assert.equal(env.intLimit("DAILY_GEN_QUOTA", 10), 10);
  // Override numérique ; 0 = kill-switch (coupe tout).
  process.env.DAILY_GEN_QUOTA = "3";
  assert.equal(env.intLimit("DAILY_GEN_QUOTA", 10), 3);
  process.env.DAILY_GEN_QUOTA = "0";
  assert.equal(env.intLimit("DAILY_GEN_QUOTA", 10), 0);
  // Levée EXPLICITE seulement.
  process.env.DAILY_GEN_QUOTA = "unlimited";
  assert.equal(env.intLimit("DAILY_GEN_QUOTA", 10), null);
  // Faute de frappe → on RETOMBE sur le défaut, jamais sur « pas de limite ».
  process.env.DAILY_GEN_QUOTA = "abc";
  assert.equal(env.intLimit("DAILY_GEN_QUOTA", 10), 10);
});

test("quota quotidien : compte au-delà du cap → 429 ; un AUTRE compte passe", async () => {
  process.env.DAILY_ASSIST_QUOTA = "2"; // pose un quota → suivi actif
  await ctx.runWithUser("q-heavy", async () => {
    assert.equal(await guards.generationGate("assist"), null);
    await guards.recordGeneration("assist", "drill");
    await guards.recordGeneration("assist", "drill");
    const gate = await guards.generationGate("assist");
    assert.ok(gate && gate.status === 429, "le compte au quota doit être refusé");
  });
  // L'isolation : un autre compte n'est pas affecté par le quota du premier.
  await ctx.runWithUser("q-fresh", async () => {
    assert.equal(await guards.generationGate("assist"), null, "un autre compte ne doit pas hériter du quota");
  });
});

test("rate limit PAR UTILISATEUR (pas par processus) : burst d'un compte → 429, un autre passe", async () => {
  process.env.AUTH_ENABLED = "1";             // suivi actif (store)
  process.env.DAILY_ASSIST_QUOTA = "unlimited"; // isole le rate du quota quotidien
  process.env.RATE_LIMIT_PER_USER_MIN = "2";
  await ctx.runWithUser("rate-a", async () => {
    await guards.recordGeneration("assist", "drill");
    await guards.recordGeneration("assist", "drill");
    const gate = await guards.generationGate("assist");
    assert.ok(gate && gate.status === 429 && /minute/.test(gate.error), "burst du même compte → 429/minute");
  });
  await ctx.runWithUser("rate-b", async () => {
    assert.equal(await guards.generationGate("assist"), null, "le compteur est PAR UTILISATEUR, pas global");
  });
});

test("plafond de dépense PAR UTILISATEUR : compte au-delà → SPEND_CAP ; un autre passe", async () => {
  process.env.AUTH_ENABLED = "1";
  process.env.SPEND_CAP_PER_USER_USD = "1"; // 1 $/user/jour
  // gros dépensier : 1 MTok in sur Sonnet (2 $/MTok) = 2 $ > 1 $
  await ctx.runWithUser("spend-big", async () => {
    await usage.recordUsage({ provider: "anthropic", model: "claude-sonnet-5", tokensIn: 1_000_000, tokensOut: 0 });
    assert.ok((await usage.spentTodayByUser()) >= 1);
    await assert.rejects(
      () => usage.assertSpendCap("anthropic"),
      (e: Error & { code?: string }) => e.code === "SPEND_CAP" && /ce compte/.test(e.message),
      "le compte au-delà de SON plafond doit être coupé",
    );
  });
  // un compte qui n'a rien dépensé passe (le plafond global aurait tout coupé).
  await ctx.runWithUser("spend-none", async () => {
    await usage.assertSpendCap("anthropic");
  });
  // claude-code (gratuit) n'est JAMAIS coupé, même pour le gros dépensier.
  await ctx.runWithUser("spend-big", async () => {
    await usage.assertSpendCap("claude-code");
  });
});

test("mesure : llm_usage écrit pour le provider CLI local quand le suivi est actif (estimated=1, coût 0)", async () => {
  process.env.CORTEX_TRACK_USAGE = "1";
  await ctx.runWithUser("free-user", async () => {
    await usage.recordUsage({ provider: "claude-code", model: "opus", tokensIn: 500, tokensOut: 200, latencyMs: 1234 });
  });
  const rows = await authAll<{ provider: string; estimated: number; cost_usd: number; tokens_in: number; latency_ms: number }>(
    "SELECT provider, estimated, cost_usd, tokens_in, latency_ms FROM llm_usage WHERE user_id = ?", "free-user",
  );
  assert.equal(rows.length, 1, "une ligne écrite même pour le provider gratuit");
  assert.equal(rows[0].provider, "claude-code");
  assert.equal(Number(rows[0].estimated), 1, "provider gratuit → estimated=1 (distinct d'une mesure)");
  assert.equal(Number(rows[0].cost_usd), 0, "provider gratuit → coût 0");
  assert.equal(Number(rows[0].tokens_in), 500);
  assert.equal(Number(rows[0].latency_ms), 1234);
});
