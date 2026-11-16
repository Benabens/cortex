/**
 * QCM DÉJÀ LIVRÉ, PUIS ÉCHEC — les questions sont visibles sur /mock/<id> (onExamReady a posé
 * result_id) quand le worker meurt (OOM, redéploiement sans arrêt gracieux) ou lève après la
 * livraison. L'échec ne rend que ce qui manque, au prorata des questions commandées : un QCM
 * complet n'est pas remboursé, et un QCM sans livraison l'est toujours en entier.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const ENV: Record<string, string> = {
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  AI_BUDGET_MARGIN: "unlimited",
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "10",
  DAILY_GEN_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
  MAX_GLOBAL_JOBS: "unlimited",
  // Tarif figé ici : le test porte sur le prorata, pas sur le prix courant.
  CREDITS_COST_JSON: JSON.stringify({ qcm: 1, exam: 2 }),
};

Object.assign(process.env, ENV);

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
  for (const k of Object.keys(ENV)) delete process.env[k];
});

/**
 * Un examen QCM commandé (job `type`), dont `closed` questions fermées et `open` ouvertes sont en
 * base, livré au sens d'onExamReady (result_id + taille commandée résolue par le générateur,
 * `ordered`), puis son worker mort pour de bon.
 */
async function deliveredThenDead(user: string, d: { type?: "qcm" | "exam"; closed: number; open?: number; ordered?: number; delivered?: boolean }) {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  return runWithUser(user, () => runWithCourse("ml", async () => {
    const start = await credits.getBalanceCenti(user);
    // Cible sans taille : c'est le format du cours qui la décide, au générateur — pas la cible.
    const { id } = await jobs.createJobExclusive(d.type ?? "qcm", JSON.stringify({}));
    const cost = start - (await credits.getBalanceCenti(user));
    await q.ensureTable("exams");
    await q.ensureTable("qcm_items");
    await q.ensureTable("exam_questions");
    const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','generating')`);
    for (let i = 0; i < d.closed; i++) {
      await q.run(
        `INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        examId, i, "Notion fictive", "scq", `Question fictive ${i}`, `["a","b"]`, "[0]", "[]", "Explication fictive.", 1,
      );
    }
    for (let i = 0; i < (d.open ?? 0); i++) {
      await q.run(`INSERT INTO exam_questions (exam_id, concept, statement_html, source_inspiration) VALUES (?,?,?,'qcm-open')`, examId, "Notion fictive", `<p>Question ouverte fictive ${i}</p>`);
    }
    if (d.delivered !== false) await jobs.setJob(id, { status: "running", resultId: examId, resultPath: `/mock/${examId}`, ordered: d.ordered, progress: 82 });
    else await jobs.setJob(id, { status: "running", progress: 40 });
    // Worker mort : PID inexistant, plus de battement, tentatives épuisées → la réconciliation conclut à l'échec.
    await q.run(`UPDATE jobs SET pid = 999999, heartbeat_at = '2020-01-01 00:00:00', attempts = max_attempts, updated_at = ? WHERE id = ?`, nowStr(), id);
    await jobs.reconcileStaleJobs();
    const job = await jobs.getJob(id);
    return { status: job?.status, cost, refunded: (await credits.getBalanceCenti(user)) - (start - cost) };
  }));
}

test("QCM de 12 + 2 (taille du format du cours) livré en entier, puis worker mort : rien n'est remboursé", async () => {
  const r = await deliveredThenDead("usr_qcm_complet", { closed: 12, open: 2, ordered: 14 });
  assert.equal(r.status, "error");
  assert.equal(r.cost, 100);
  assert.equal(r.refunded, 0);
});

test("QCM de 20 + 3 mort pendant les questions ouvertes (20 fermées visibles) : seules les 3 ouvertes sont remboursées", async () => {
  const r = await deliveredThenDead("usr_qcm_ouvertes", { closed: 20, ordered: 23 });
  // 3 questions sur 23 manquent : la part se compte en millièmes (130 ‰), soit 13 centièmes sur 100.
  assert.equal(r.refunded, 13);
});

test("examen blanc d'un cours au format QCM (job exam) livré à 15 sur 20 : seul le quart manquant est remboursé", async () => {
  const r = await deliveredThenDead("usr_exam_qcm", { type: "exam", closed: 15, ordered: 20 });
  assert.equal(r.cost, 200);
  assert.equal(r.refunded, 50);
});

test("examen mort avant toute livraison : toujours remboursé en entier", async () => {
  const r = await deliveredThenDead("usr_qcm_rien", { closed: 0, delivered: false });
  assert.equal(r.refunded, 100);
});

test("livraison sans taille commandée connue (autre générateur) : remboursé en entier, comme avant", async () => {
  const r = await deliveredThenDead("usr_exam_blocs", { type: "exam", closed: 0 });
  assert.equal(r.refunded, 200);
});
