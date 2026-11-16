/**
 * QCM DÉJÀ LIVRÉ, PUIS ÉCHEC — les questions sont visibles sur /mock/<id> (onExamReady a posé
 * result_id) quand le worker meurt (OOM, redéploiement sans arrêt gracieux) ou lève après la
 * livraison. L'échec ne rend que ce qui manque, au prorata des questions commandées : un QCM
 * complet n'est pas remboursé, et un QCM sans livraison l'est toujours en entier.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AI_BUDGET_MARGIN = "unlimited";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "10";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";
process.env.MAX_GLOBAL_JOBS = "unlimited";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { nowStr, q } from "../db/q";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "AI_BUDGET_MARGIN", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS", "MAX_GLOBAL_JOBS"]) delete process.env[k];
});

/** Un QCM de 20 questions fermées commandé, dont `delivered` sont en base, puis son worker mort pour de bon. */
async function deliveredThenDead(user: string, delivered: number, opts: { open?: number; withResult?: boolean } = {}) {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  return runWithUser(user, () => runWithCourse("ml", async () => {
    const start = await credits.getBalanceCenti(user);
    const { id } = await jobs.createJobExclusive("qcm", JSON.stringify({ count: 20, openCount: opts.open ?? 0 }));
    await q.ensureTable("exams");
    await q.ensureTable("qcm_items");
    await q.ensureTable("exam_questions");
    const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','generating')`);
    for (let i = 0; i < delivered; i++) {
      await q.run(
        `INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        examId, i, "Notion fictive", "scq", `Question fictive ${i}`, `["a","b"]`, "[0]", "[]", "Explication fictive.", 1,
      );
    }
    if (opts.withResult !== false) await jobs.setJob(id, { status: "running", resultId: examId, resultPath: `/mock/${examId}`, progress: 92 });
    else await jobs.setJob(id, { status: "running", progress: 40 });
    // Worker mort : PID inexistant, plus de battement, tentatives épuisées → la réconciliation conclut à l'échec.
    await q.run(`UPDATE jobs SET pid = 999999, heartbeat_at = '2020-01-01 00:00:00', attempts = max_attempts, updated_at = ? WHERE id = ?`, nowStr(), id);
    await jobs.reconcileStaleJobs();
    const job = await jobs.getJob(id);
    return { status: job?.status, refunded: (await credits.getBalanceCenti(user)) - (start - 100) };
  }));
}

test("QCM livré en entier (20/20) puis worker mort : rien n'est remboursé", async () => {
  const r = await deliveredThenDead("usr_qcm_complet", 20);
  assert.equal(r.status, "error");
  assert.equal(r.refunded, 0);
});

test("QCM livré à 15/20 puis worker mort : seul le quart manquant est remboursé", async () => {
  const r = await deliveredThenDead("usr_qcm_partiel", 15);
  assert.equal(r.refunded, 25);
});

test("questions ouvertes commandées et absentes : comptées dans le manque (20 QCM livrés sur 20 + 3 ouvertes)", async () => {
  const r = await deliveredThenDead("usr_qcm_ouvertes", 20, { open: 3 });
  // 3 questions sur 23 manquent : la part se compte en millièmes (130 ‰), soit 13 centièmes sur 100.
  assert.equal(r.refunded, 13);
});

test("QCM mort avant toute livraison : toujours remboursé en entier", async () => {
  const r = await deliveredThenDead("usr_qcm_rien", 0, { withResult: false });
  assert.equal(r.refunded, 100);
});
