/**
 * Remboursement d'un job selon ce qu'il a produit :
 *  - ÉCHEC (rien produit) → rendu EN ENTIER, même si des appels ont coûté :
 *    c'est notre défaut, pas celui de l'utilisateur, et il n'a rien reçu ;
 *  - ANNULATION par l'utilisateur → rendue seulement si le job n'a rien coûté
 *    (coût LLM réel nul : même compte, même cours, même id) — sinon annuler à
 *    95 % puis relancer offrirait des générations illimitées (B6) ;
 *  - examen INCOMPLET → rendu au prorata des questions manquantes.
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

test("job annulé SANS appel payant → remboursé ; AVEC coût réel → pas remboursé", async () => {
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
    await jobs.refundJobCredits({ id: 41, type: "exam" }, "canceled");
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
    await jobs.refundJobCredits({ id: 42, type: "exam" }, "canceled");
    assert.equal(await credits.getBalanceCenti("erin"), start - 200, "une annulation après des appels payants n'est pas remboursée");

    // Job 43 : appels du provider GRATUIT (claude-code, coût 0, estimated=1) → remboursé.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", ref: credits.jobRef("erin", "ml", 43) })).ok, true);
    await authRun(
      `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      "erin", "ml", "claude-code", "opus", 1000, 500, 0, 1, "43", "qcm:generateQcmExam", "2026-09-26 10:00:00",
    );
    await jobs.refundJobCredits({ id: 43, type: "qcm" }, "canceled");
    assert.equal(await credits.getBalanceCenti("erin"), start - 200);

    // Le job 42 d'un AUTRE compte (même id, autre tenant) n'est pas confondu : ses lignes ne comptent pas.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "exam", ref: credits.jobRef("erin", "algo", 42) })).ok, true);
  }));
  await runWithUser("erin", () => runWithCourse("algo", () => jobs.refundJobCredits({ id: 42, type: "exam" }, "canceled")));
  assert.equal(await credits.getBalanceCenti("erin"), 1000 - 200, "le job 42 du cours algo n'a rien coûté : remboursé");
});

test("jobLlmCostUsd : somme des lignes rattachées (compte, cours, id)", async () => {
  const jobs = await import("../lib/jobs");
  assert.equal(await jobs.jobLlmCostUsd("erin", "ml", 42), 0.03);
  assert.equal(await jobs.jobLlmCostUsd("erin", "ml", 41), 0);
  assert.equal(await jobs.jobLlmCostUsd("erin", "algo", 42), 0);
});

async function paidCall(user: string, course: string, jobId: number, cost: number) {
  const { authRun } = await import("../db/auth-store");
  await authRun(
    `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    user, course, "anthropic", "claude-sonnet-5", 1000, 500, cost, 0, String(jobId), "qcm:generateQcmBatch", "2026-11-01 10:00:00",
  );
}

test("job ÉCHOUÉ après des appels payants (rien produit) → rendu en entier, une seule fois", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const jobs = await import("../lib/jobs");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  await runWithUser("fred", () => runWithCourse("ml", async () => {
    const start = await credits.getBalanceCenti("fred");
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", ref: credits.jobRef("fred", "ml", 6) })).ok, true);
    await paidCall("fred", "ml", 6, 0.31); // le job 6 de CS-290 : « le job a déjà coûté 0,31 $ »
    assert.equal(await jobs.refundJobCredits({ id: 6, type: "qcm" }, "failed"), 100);
    assert.equal(await credits.getBalanceCenti("fred"), start, "un échec qui n'a rien produit est rendu, coût à notre charge");
    assert.equal(await jobs.refundJobCredits({ id: 6, type: "qcm" }, "failed"), 0, "idempotent");
    assert.equal(await credits.getBalanceCenti("fred"), start);
  }));
});

test("examen INCOMPLET → remboursé au prorata des questions manquantes, et le job le dit", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const jobs = await import("../lib/jobs");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  await runWithUser("gina", () => runWithCourse("ml", async () => {
    const start = await credits.getBalanceCenti("gina");
    // QCM à 1 crédit (100 centièmes), 7 QCM + 3 ouvertes demandés, 8 produits → 2/10 rendus.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", ref: credits.jobRef("gina", "ml", 2) })).ok, true);
    await paidCall("gina", "ml", 2, 0.2);
    const notice = await jobs.settleShortfall({ id: 2, type: "qcm" }, 8, 10);
    assert.equal(await credits.getBalanceCenti("gina"), start - 100 + 20);
    assert.match(notice ?? "", /2 questions sur 10 n'ont pas pu être générées/);
    assert.match(notice ?? "", /0,2 crédit rendu/);
    assert.equal(await jobs.settleShortfall({ id: 2, type: "qcm" }, 8, 10), notice?.replace(/ : 0,2 crédit rendu/, ""), "rejoué : rien de plus n'est rendu");
    assert.equal(await credits.getBalanceCenti("gina"), start - 100 + 20);
    // Au prorata ARRONDI en faveur de l'utilisateur : 2/7 de 100 → 29.
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", ref: credits.jobRef("gina", "ml", 4) })).ok, true);
    await jobs.settleShortfall({ id: 4, type: "qcm" }, 5, 7);
    assert.equal(await credits.getBalanceCenti("gina"), start - 100 + 20 - 100 + 29);
    // Complet : rien à signaler, rien rendu.
    assert.equal(await jobs.settleShortfall({ id: 4, type: "qcm" }, 7, 7), null);
  }));
});

