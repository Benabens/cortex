/**
 * Rapport de coût : depuis llm_usage, coût réel moyen / max par type de job et
 * par appel d'assistance, comparé au prix en crédits — pour fixer les prix sur
 * des mesures. Hermétique (store sqlite temporaire).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-costrep-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.CREDIT_PRICE_CHF = "2.5";
process.env.CHF_PER_USD = "0.8";
delete process.env.CREDITS_COST_JSON;

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "CREDIT_PRICE_CHF", "CHF_PER_USD"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("costReport : agrège par job puis par type, et compare au prix en crédits", async () => {
  const { authRun } = await import("../db/auth-store");
  const ins = (user: string, course: string, job: string | null, site: string, cost: number, estimated = 0) =>
    authRun(
      `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      user, course, "anthropic", "claude-sonnet-5", 1000, 500, cost, estimated, job, site, "2026-09-26 10:00:00",
    );
  // Deux examens : 1,00 $ (deux appels) et 3,00 $ ; un mock QCM à 0,40 $ ; deux drills à 0,05 et 0,15 $.
  await ins("a", "ml", "1", "exam:generateBatch", 0.6);
  await ins("a", "ml", "1", "exam:verify", 0.4);
  await ins("b", "ml", "1", "exam:generateBatch", 3.0); // même id, autre compte : autre job
  await ins("a", "ml", "2", "qcm:generateQcmExam", 0.4);
  await ins("a", "ml", null, "generateDrill", 0.05);
  await ins("a", "ml", null, "generateDrill", 0.15, 1);

  const { costReport } = await import("../lib/billing/cost-report");
  const r = await costReport();
  const exam = r.jobs.find((j) => j.type === "exam")!;
  assert.equal(exam.jobs, 2);
  assert.equal(exam.avgUsd, 2);
  assert.equal(exam.maxUsd, 3);
  assert.equal(exam.priceCredits, 2);
  assert.equal(exam.priceChf, 5);           // 2 crédits × 2,5 CHF
  assert.equal(exam.avgCostChf, 1.6);       // 2 $ × 0,8
  assert.equal(exam.marginPct, 68);         // (5 − 1,6) / 5
  const qcm = r.jobs.find((j) => j.type === "qcm")!;
  assert.equal(qcm.jobs, 1);
  assert.equal(qcm.maxUsd, 0.4);
  const drill = r.assist.find((a) => a.callSite === "generateDrill")!;
  assert.equal(drill.calls, 2);
  assert.equal(drill.avgUsd, 0.1);
  assert.equal(drill.maxUsd, 0.15);
  assert.equal(drill.priceCredits, 0.1);
  assert.equal(drill.estimatedCalls, 1);
  assert.match(r.text, /exam/);
  assert.match(r.text, /generateDrill/);
});
