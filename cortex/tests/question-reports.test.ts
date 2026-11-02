/**
 * BOUCLE DE RELECTURE (lib/question-reports) — relecture du mock 4 de CS-290 par
 * Ben : chaque relecture doit améliorer le moteur pour tous. Un signalement
 * (réponse fausse · hors programme / définition différente du cours · doublon ·
 * énoncé ambigu) :
 *  - retire la question des révisions de l'utilisateur ;
 *  - devient un contre-exemple des prochaines générations de CE cours ;
 *  - « réponse fausse » : re-vérifiée à l'aveugle contre le cours ; confirmée →
 *    la question est remboursée (sa part de l'examen, une seule fois) ;
 *  - est listé pour le propriétaire de l'instance.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-reports-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "10";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

/** Clé que le juge à l'aveugle trouve pour la question re-vérifiée. */
let judgeKey = 0;
const prompts: string[] = [];
let llm: http.Server;
const USER = "usr_reports";

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const content = (JSON.parse(body).messages as { content: unknown }[]).map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      prompts.push(content);
      let text = "{}";
      if (/"results"/.test(content)) text = JSON.stringify({ results: [{ index: 0, correct: [judgeKey], ok: judgeKey === 0, discrimination: 4, name_only: false, issue: judgeKey === 0 ? "" : "la clé proposée contredit le cours", course_terms: [], off_course: "" }] });
      else if (/"items"/.test(content)) text = JSON.stringify({ items: [{ topic: "t", type: "scq", stem: "Nouvelle question ?", options: ["Une option complète.", "Une autre option complète."], correct: [0], misconceptions: ["", "x"], explanation: "Parce que." }] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const STEM = "Un attribut est-il sensible seulement s'il est protégé par la loi ?";

/** Un examen QCM payé (1 crédit) : 2 QCM + 1 ouverte, la 1ʳᵉ QCM aussi dans les révisions. */
async function paidExam(): Promise<{ examId: number; itemIds: number[]; openId: number }> {
  const { q } = await import("../db/q");
  const { getQcmExam } = await import("../lib/qcm");
  const jobs = await import("../lib/jobs");
  await getQcmExam(0); // amorce le schéma QCM du cours
  for (const t of ["revision_plan", "exam_questions"]) await q.ensureTable(t);
  const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
  const itemIds: number[] = [];
  for (const [idx, stem] of [[0, STEM], [1, "Que calcule le DIR ?"]] as const) {
    itemIds.push(await q.insert(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      examId, idx, "Fairness 1", "scq", stem, JSON.stringify(["Oui, seulement s'il est protégé par la loi.", "Non : dès qu'il a des implications éthiques."]), JSON.stringify([0]), "[]", "…", 1));
  }
  const openId = await q.insert(`INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration) VALUES (?,?,?,?,?)`, examId, "DIR", "Calculez le DIR.", "0,8.", "qcm-open");
  await q.run(`INSERT INTO revision_plan (kind, topic, statement, options, correct, verified) VALUES ('qcm',?,?,?,?,?)`, "Fairness 1", STEM, "A) …\nB) …", "A", 1);
  const { id } = await jobs.createJobExclusive("qcm");
  await jobs.setJob(id, { status: "done", progress: 100, resultId: examId, resultPath: `/mock/${examId}` });
  return { examId, itemIds, openId };
}

test("réponse fausse confirmée par la re-vérification : retirée des révisions, remboursée une fois à sa part", async () => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const credits = await import("../lib/billing/credits");
  const { reportQuestion } = await import("../lib/question-reports");
  await runWithUser(USER, () => runWithCourse("ml", async () => {
    const { examId, itemIds } = await paidExam();
    const before = await credits.getBalanceCenti(USER);
    judgeKey = 1; // le juge, avec les extraits du cours, trouve l'AUTRE réponse
    const r = await reportQuestion({ examId, kind: "qcm", itemId: itemIds[0], reason: "wrong_answer", comment: "Le cours dit : sensible dès qu'il a des implications éthiques." });
    assert.equal(r.status, "confirmed");
    assert.equal(r.refundedCenti, 34, "1 crédit pour 3 questions : 34 centièmes (arrondi en faveur de l'utilisateur)");
    assert.equal(await credits.getBalanceCenti(USER), before + 34);
    assert.equal(r.removedFromRevision, 1);
    assert.equal((await q.get<{ n: number }>(`SELECT count(*) n FROM revision_plan WHERE statement = ?`, STEM))?.n, 0);
    assert.equal((await q.get<{ verified: number }>(`SELECT verified FROM qcm_items WHERE id = ?`, itemIds[0]))?.verified, 0);
    const again = await reportQuestion({ examId, kind: "qcm", itemId: itemIds[0], reason: "wrong_answer" });
    assert.equal(again.refundedCenti, 0, "une question n'est remboursée qu'une fois");
    assert.equal(await credits.getBalanceCenti(USER), before + 34);
  }));
});

test("réponse fausse NON confirmée : signalement gardé, rien remboursé", async () => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const credits = await import("../lib/billing/credits");
  const { reportQuestion } = await import("../lib/question-reports");
  await runWithUser(USER, () => runWithCourse("ml", async () => {
    const { examId, itemIds } = await paidExam();
    const before = await credits.getBalanceCenti(USER);
    judgeKey = 0;
    const r = await reportQuestion({ examId, kind: "qcm", itemId: itemIds[1], reason: "wrong_answer" });
    assert.equal(r.status, "not_confirmed");
    assert.equal(r.refundedCenti, 0);
    assert.equal(await credits.getBalanceCenti(USER), before);
  }));
});

test("un signalement devient un contre-exemple des prochaines générations de CE cours", async () => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { reportQuestion, counterExamplesBlock } = await import("../lib/question-reports");
  const { generateQcmBatch } = await import("../lib/qcm");
  await runWithUser(USER, () => runWithCourse("ml", async () => {
    const { examId, openId } = await paidExam();
    await reportQuestion({ examId, kind: "open", itemId: openId, reason: "ambiguous", comment: "On ne sait pas quel groupe est favorisé." });
    const block = await counterExamplesBlock();
    assert.match(block, /NE REFAIS PAS/);
    assert.match(block, /Énoncé ambigu[\s\S]*Calculez le DIR[\s\S]*quel groupe est favorisé/);
    prompts.length = 0;
    await generateQcmBatch([{ label: "DIR", method: null }], 1, () => {});
    assert.match(prompts.find((p) => /"items"/.test(p)) ?? "", /NE REFAIS PAS[\s\S]*Calculez le DIR/);
  }));
  await runWithUser("usr_other", () => runWithCourse("ml", async () => {
    assert.equal(await counterExamplesBlock(), "", "les signalements d'un autre compte ne s'appliquent pas");
  }));
});

test("le propriétaire voit les signalements de tous les comptes ; une saisie invalide est refusée", async () => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { reportQuestion, listReports, ReportError } = await import("../lib/question-reports");
  await runWithUser("usr_bis", () => runWithCourse("algo", async () => {
    const { examId, itemIds } = await paidExam();
    await reportQuestion({ examId, kind: "qcm", itemId: itemIds[1], reason: "duplicate", comment: "Même question que la 2." });
    await assert.rejects(reportQuestion({ examId, kind: "qcm", itemId: itemIds[1], reason: "nope" as never }), ReportError);
    await assert.rejects(reportQuestion({ examId, kind: "qcm", itemId: 999_999, reason: "duplicate" }), ReportError);
  }));
  const all = await listReports(50);
  assert.ok(all.some((r) => r.userId === "usr_bis" && r.course === "algo" && r.reason === "duplicate" && /Que calcule le DIR/.test(r.stem)));
  assert.ok(all.some((r) => r.userId === USER && r.status === "confirmed"));
});

test("route POST /api/questions/report : motif inconnu → 400 au message lisible ; question absente → 404", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/questions/report/route");
  const post = (body: unknown) => new NextRequest("http://cortex.test/api/questions/report?course=ml", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const bad = await POST(post({ examId: 1, kind: "qcm", itemId: 1, reason: "spam" }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /Motif de signalement inconnu/);
  const missing = await POST(post({ examId: 424242, kind: "qcm", itemId: 1, reason: "duplicate" }));
  assert.equal(missing.status, 404);
});


test("une question ne se re-vérifie qu'une fois : un nouveau « réponse fausse » reprend le verdict sans rappeler le modèle", async () => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { reportQuestion } = await import("../lib/question-reports");
  await runWithUser(USER, () => runWithCourse("ml", async () => {
    const { examId, itemIds } = await paidExam();
    judgeKey = 0;
    assert.equal((await reportQuestion({ examId, kind: "qcm", itemId: itemIds[1], reason: "wrong_answer" })).status, "not_confirmed");
    const calls = prompts.length;
    for (let i = 0; i < 3; i++) assert.equal((await reportQuestion({ examId, kind: "qcm", itemId: itemIds[1], reason: "wrong_answer" })).status, "not_confirmed");
    assert.equal(prompts.length, calls, "aucun appel au modèle de plus");
  }));
});
