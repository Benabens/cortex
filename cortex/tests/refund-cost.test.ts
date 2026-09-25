/**
 * B6 — un job échoué n'est remboursé QUE si son coût LLM réel (llm_usage
 * rattaché au job : même compte, même cours, même id) est nul. Un document
 * piégé qui fait planter la génération après des appels payants ne donne
 * plus de générations gratuites.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-refund-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "10";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("job échoué SANS appel payant → remboursé ; AVEC coût réel → pas remboursé", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const jobs = await import("../lib/jobs");
  const { authRun } = await import("../db/auth-store");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");

  await runWithUser("erin", () => runWithCourse("ml", async () => {
    const start = await credits.getBalanceCenti("erin"); // 1000
    // Job 41 : réservé, échoue avant tout appel (rien dans llm_usage) → remboursé.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "exam", ref: credits.jobRef("erin", "ml", 41) })).ok, true);
    await jobs.refundJobCredits({ id: 41, type: "exam" });
    assert.equal(await credits.getBalanceCenti("erin"), start, "un job sans coût réel doit être remboursé");

    // Job 42 : réservé, deux appels payants enregistrés (0,03 $), puis échec → NON remboursé.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "exam", ref: credits.jobRef("erin", "ml", 42) })).ok, true);
    for (const cost of [0.02, 0.01]) {
      await authRun(
        `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        "erin", "ml", "anthropic", "claude-sonnet-5", 1000, 500, cost, 0, "42", "exam:generateBatch", "2026-09-26 10:00:00",
      );
    }
    await jobs.refundJobCredits({ id: 42, type: "exam" });
    assert.equal(await credits.getBalanceCenti("erin"), start - 200, "un job qui a coûté de l'argent ne doit pas être remboursé");

    // Job 43 : appels du provider GRATUIT (claude-code, coût 0, estimated=1) → remboursé.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", ref: credits.jobRef("erin", "ml", 43) })).ok, true);
    await authRun(
      `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      "erin", "ml", "claude-code", "opus", 1000, 500, 0, 1, "43", "qcm:generateQcmExam", "2026-09-26 10:00:00",
    );
    await jobs.refundJobCredits({ id: 43, type: "qcm" });
    assert.equal(await credits.getBalanceCenti("erin"), start - 200);

    // Le job 42 d'un AUTRE compte (même id, autre tenant) n'est pas confondu : ses lignes ne comptent pas.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "exam", ref: credits.jobRef("erin", "algo", 42) })).ok, true);
  }));
  await runWithUser("erin", () => runWithCourse("algo", () => jobs.refundJobCredits({ id: 42, type: "exam" })));
  assert.equal(await credits.getBalanceCenti("erin"), 1000 - 200, "le job 42 du cours algo n'a rien coûté : remboursé");
});

test("jobLlmCostUsd : somme des lignes rattachées (compte, cours, id)", async () => {
  const jobs = await import("../lib/jobs");
  assert.equal(await jobs.jobLlmCostUsd("erin", "ml", 42), 0.03);
  assert.equal(await jobs.jobLlmCostUsd("erin", "ml", 41), 0);
  assert.equal(await jobs.jobLlmCostUsd("erin", "algo", 42), 0);
});
