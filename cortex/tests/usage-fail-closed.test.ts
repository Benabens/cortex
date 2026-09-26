/**
 * LOT 2b-8 — comptage en vol FAIL-CLOSED en déploiement gardé : si la ligne
 * provisoire llm_usage ne peut pas être écrite (base injoignable), l'appel payant
 * ne part PAS (LlmError UNAVAILABLE → 503) — sinon la dépense échappe au plafond.
 * En dev (rien de gardé), le comportement fail-open est conservé.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string>).NODE_ENV = "development";

let authRun: typeof import("../db/auth-store").authRun;
before(async () => {
  ({ authRun } = await import("../db/auth-store"));
  await authRun("SELECT 1");
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "AUTH_ENABLED", "CORTEX_HOSTED", "RAILWAY_ENVIRONMENT"]) delete process.env[k];
});

const est = { provider: "anthropic", model: "claude-sonnet-5", tokensIn: 10, tokensOut: 10 };

test("base injoignable : gardé → refus ; non gardé → null (fail-open historique)", async () => {
  const { openUsage } = await import("../lib/billing/usage");
  const { LlmError } = await import("../lib/llm/types");
  assert.ok((await openUsage(est)) !== null, "écriture normale");
  await authRun("ALTER TABLE llm_usage RENAME TO llm_usage_off");
  try {
    delete process.env.BILLING_ENABLED; delete process.env.AUTH_ENABLED; delete process.env.CORTEX_HOSTED; delete process.env.RAILWAY_ENVIRONMENT;
    assert.equal(await openUsage(est), null);
    for (const k of ["BILLING_ENABLED", "AUTH_ENABLED", "CORTEX_HOSTED"]) {
      process.env[k] = "1";
      await assert.rejects(openUsage(est), (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE", `${k}=1 doit refuser`);
      delete process.env[k];
    }
    process.env.RAILWAY_ENVIRONMENT = "production";
    await assert.rejects(openUsage(est), (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE");
    delete process.env.RAILWAY_ENVIRONMENT;
  } finally {
    await authRun("ALTER TABLE llm_usage_off RENAME TO llm_usage");
  }
  assert.ok((await openUsage(est)) !== null, "rétabli");
});
