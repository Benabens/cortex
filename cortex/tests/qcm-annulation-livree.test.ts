/**
 * ANNULATION D'UN EXAMEN QCM DÉJÀ VISIBLE — banc HUM-285 du 16/11/2026 : 20/20 QCM vérifiés à
 * 46 min, questions visibles dans l'examen, puis annulation à 90 min (garde du banc, ou
 * l'étudiant qui trouve l'attente trop longue) : 0 question livrée et aucun crédit rendu.
 * Verrouillé : une annulation conserve les questions déjà visibles, le job finit « done » et seul
 * le manque est rendu, au prorata. Sans question visible, la règle d'annulation reste celle de
 * refund-cost (rien n'est rendu après des appels payants).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-annulation-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.AI_BUDGET_MARGIN = "unlimited";
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
  for (const k of ["CORTEX_DATA_DIR", "AI_BUDGET_MARGIN", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function paidCall(user: string, course: string, jobId: number, cost: number) {
  const { authRun } = await import("../db/auth-store");
  await authRun(
    `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    user, course, "anthropic", "claude-sonnet-5", 1000, 500, cost, 0, String(jobId), "qcm:generateQcmBatch", "2026-11-16 10:00:00",
  );
}

/** Job QCM réservé et lancé, `visible` QCM déjà dans l'examen (livraison progressive), ouvertes en cours. */
async function runningQcmJob(user: string, visible: number, ordered: number) {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { q } = await import("../db/q");
  const jobs = await import("../lib/jobs");
  const id = await jobs.createJob("qcm", JSON.stringify({ count: ordered - 3, openCount: 3 }));
  assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", ref: credits.jobRef(user, "ml", id) })).ok, true);
  await paidCall(user, "ml", id, 1.2);
  await q.ensureTable("exams");
  await q.ensureColumns("exams", ["verify_summary"]);
  await q.ensureTable("exam_questions");
  await q.ensureTable("qcm_items");
  const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','generating')`);
  for (let i = 0; i < visible; i++) {
    await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      examId, i, `Notion ${i}`, "scq", `Question ${i}`, JSON.stringify(["a", "b", "c", "d"]), "[0]", "[]", "", 1);
  }
  if (visible) await jobs.setJob(id, { status: "running", progress: 82, resultId: examId, resultPath: `/mock/${examId}`, ordered });
  else await jobs.setJob(id, { status: "running", progress: 60 });
  return { id, examId };
}

test("annulation après 20 QCM visibles : ils restent livrés, le job finit, seules les ouvertes sont rendues", async () => {
  const credits = await import("../lib/billing/credits");
  const jobs = await import("../lib/jobs");
  const { q } = await import("../db/q");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  await runWithUser("hugo", () => runWithCourse("ml", async () => {
    const start = await credits.getBalanceCenti("hugo");
    const { id, examId } = await runningQcmJob("hugo", 20, 23);
    const job = await jobs.cancelJob(id);
    assert.equal(job?.status, "done", "une livraison déjà visible n'est pas une annulation");
    assert.equal((await q.get<{ n: number }>(`SELECT count(*) n FROM qcm_items WHERE exam_id = ?`, examId))?.n, 20, "les QCM visibles restent");
    const exam = await q.get<{ status: string; verify_summary: string | null }>(`SELECT status, verify_summary FROM exams WHERE id = ?`, examId);
    assert.equal(exam?.status, "ready", "l'examen reste consultable et ne se dit plus en cours");
    assert.equal(exam?.verify_summary, "20 QCM vérifiés · 0 question ouverte sur 3");
    // 3 ouvertes sur 23 questions manquent : 130 ‰ (fraction au millième) de 400 centièmes.
    assert.equal(await credits.getBalanceCenti("hugo"), start - 400 + 52);
    assert.match(job?.currentStep ?? "", /3 questions sur 23/);
  }));
});

test("annulation avant toute question visible, après des appels payants : la règle d'annulation reste", async () => {
  const credits = await import("../lib/billing/credits");
  const jobs = await import("../lib/jobs");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  await runWithUser("ines", () => runWithCourse("ml", async () => {
    const start = await credits.getBalanceCenti("ines");
    const { id } = await runningQcmJob("ines", 0, 23);
    const job = await jobs.cancelJob(id);
    assert.equal(job?.status, "canceled");
    assert.equal(await credits.getBalanceCenti("ines"), start - 400);
  }));
});
