/**
 * AUDIT FUITES DU 17/11, I10 — la limite de calcul du jour d'un compte se calculait sur un coût
 * attendu périmé (QCM 4,3 $ ; 2 à 2,9 $ en prod depuis #106) avec un plancher fixe de 8 $ :
 * un abonné à 14,90 € était refusé au 3e QCM du jour, avant les « 3 générations par jour »
 * annoncées. Désormais, sans réglage, le plancher couvre toujours DAILY_GEN_QUOTA générations au
 * coût attendu le plus cher : la limite de calcul ne refuse jamais avant le quota annoncé.
 *
 * Seam : limits.getUsageLimits (le verdict commun à la route, à la réservation et au MCP).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const ENV: Record<string, string> = {
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "0",
  LLM_PROVIDER: "anthropic",
  DAILY_GEN_QUOTA: "3",
  DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
  FX_USD_JSON: JSON.stringify({ eur: 1 }),
  SPEND_CAP_USD: "1000",
  CORTEX_OWNER_USER_ID: "boss",
};
Object.assign(process.env, ENV);

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

before(async () => {
  delete process.env.CORTEX_USER;
  for (const k of ["AI_JOB_COST_USD_JSON", "SPEND_CAP_PER_USER_FLOOR_USD", "SPEND_CAP_PER_USER_USD", "CREDITS_COST_JSON"]) delete process.env[k];
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres?.();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

test("abonné à 14,90 € : ses 3 QCM du jour passent la limite de calcul, même au coût réel le plus haut mesuré (2,9 $)", async () => {
  const { authRun } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  const revenue = await import("../lib/billing/revenue");
  const credits = await import("../lib/billing/credits");
  const limits = await import("../lib/billing/limits");
  const usage = await import("../lib/billing/usage");
  const { costForJob } = await import("../lib/jobs");
  await revenue.recordPayment({ sourceId: "in_abonne", kind: "subscription", paymentIntent: "pi_abonne", userId: "abonne", currency: "eur", amountCents: 1490, feeCents: 0 });
  await credits.addTransaction("abonne", 40 * 100, "purchase", "purchase:abonne");
  const cost = costForJob("qcm", JSON.stringify({ count: 20, openCount: 3 }));
  for (let i = 1; i <= 3; i++) {
    usage.resetSpendCache();
    const shown = await runWithUser("abonne", () => runWithCourse("ml", () =>
      limits.getUsageLimits(undefined, { spec: limits.jobSpec("qcm", cost), kind: "qcm", label: "examen QCM", plural: "examens QCM" })));
    assert.equal(shown.check?.allowed, true, `QCM n° ${i} : ${shown.check?.reason ?? ""}`);
    // Le QCM tourne et coûte le haut de la fourchette mesurée en prod.
    await authRun(
      `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
       VALUES ('abonne', 'ml', 'anthropic', 'claude-sonnet-5', 1000, 500, 2.9, 0, ?, 'qcm:generateBatch', ?)`,
      String(i), nowStr(),
    );
  }
});
