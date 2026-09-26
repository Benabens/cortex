/**
 * LOT 2b-8 — comptage en vol FAIL-CLOSED en déploiement gardé : si la ligne
 * provisoire llm_usage ne peut pas être écrite (base injoignable), l'appel payant
 * ne part PAS (LlmError UNAVAILABLE → 503) — sinon la dépense échappe au plafond.
 * En dev (rien de gardé), le comportement fail-open est conservé.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-failclosed-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.SIGNUP_FREE_CREDITS = "1";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "test";
(process.env as Record<string, string>).NODE_ENV = "development";

let authRun: typeof import("../db/auth-store").authRun;
before(async () => {
  ({ authRun } = await import("../db/auth-store"));
  await authRun("SELECT 1");
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "AUTH_ENABLED", "CORTEX_HOSTED", "RAILWAY_ENVIRONMENT", "CORTEX_DATA_DIR", "SIGNUP_FREE_CREDITS", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "LLM_PROVIDER", "LLM_API_KEY", "SPEND_CAP_USD"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
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

test("revue : l'assistance débitée puis refusée par NOTRE garde (fail-closed, plafond) est remboursée ; 503", async () => {
  delete process.env.CORTEX_USER;
  process.env.BILLING_ENABLED = "1";
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { POST } = await import("../app/api/drill/route");
  const credits = await import("../lib/billing/credits");
  const post = () => new NextRequest("http://cortex.test/api/drill?course=cs-202", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ concept: "inode" }) });
  assert.equal(await credits.getBalanceCenti("owner"), 100);
  // 1) comptage en vol impossible (fail-closed) : l'appel ne part pas → remboursé.
  await authRun("ALTER TABLE llm_usage RENAME TO llm_usage_off");
  try {
    const r = await POST(post());
    assert.equal(r.status, 503, JSON.stringify(await r.clone().json()));
  } finally { await authRun("ALTER TABLE llm_usage_off RENAME TO llm_usage"); }
  assert.equal(await credits.getBalanceCenti("owner"), 100, "0,1 crédit rendu : rien n'est parti");
  // 2) plafond de dépense atteint : même chose.
  process.env.SPEND_CAP_USD = "0";
  const { resetSpendCache } = await import("../lib/billing/usage");
  resetSpendCache();
  const r2 = await POST(post());
  assert.equal(r2.status, 503);
  assert.equal(await credits.getBalanceCenti("owner"), 100);
  delete process.env.SPEND_CAP_USD;
});
