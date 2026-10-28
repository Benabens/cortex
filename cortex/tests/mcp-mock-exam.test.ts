/**
 * EXAMEN BLANC SUR UN COURS SANS ANNALES — HUM-285 (27/10/2026) : sans annales, le
 * blueprint n'avait qu'un créneau, et une demande de « ~20 QCM » produisait UN exercice.
 * Désormais l'outil suit le FORMAT du cours (lib/exam-format : annales > déclaré >
 * exemples officiels > infos de cours), ou celui demandé explicitement pour cet examen
 * (`format`) ; le focus n'est qu'un thème. Sans rien pour dire le format : refus
 * format_required, avant tout devis. Avec des annales, leur format reste la règle.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-mock-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory", MCP_ENABLED: "1", AUTH_URL: "https://cortex.test",
  BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "20", DAILY_GEN_QUOTA: "unlimited", DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited",
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_MODEL_OPUS: "claude-sonnet-5",
};
Object.assign(process.env, ENV);
delete process.env.CORTEX_OWNER_EMAIL;
delete process.env.CORTEX_OWNER_USER_ID;

const ISSUER = "https://cortex.test";
const MCP_URL = `${ISSUER}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const ALICE = "usr_alice_mock";
let withExams = "";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { insertCourse } = await import("../db/courses-store");
  const { buildCourseRow } = await import("../lib/course-create");
  const a = buildCourseRow({ name: "Histoire des sciences", code: "HUM-285" }, ALICE);
  const b = buildCourseRow({ name: "Analyse", code: "MATH-101" }, ALICE);
  await insertCourse(a);
  await insertCourse(b);
  await reloadCourses();
  withExams = b.id;
  const { runWithCourse } = await import("../db/client");
  const { runWithUser } = await import("../db/context");
  const { q } = await import("../db/q");
  await runWithUser(ALICE, () => runWithCourse(withExams, () =>
    q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Final 2024", "refs/final-2024.pdf", 2024, 2.5)));
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of Object.keys(ENV)) delete process.env[k];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ───────────────────────────── par le connecteur ─────────────────────────────

const formPost = (p: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISSUER}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });

async function client(): Promise<Client> {
  const { registerEndpoint, prepareConsent, consentDecisionEndpoint, tokenEndpoint } = await import("../lib/oauth/routes");
  const reg = await (await registerEndpoint(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude (test)", redirect_uris: [REDIRECT] }),
  }))).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const view = await prepareConsent(new Request(`${ISSUER}/oauth/authorize`), new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP_URL, state: "s",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  }), ALICE);
  if (view.kind !== "consent") throw new Error(JSON.stringify(view));
  const decided = await consentDecisionEndpoint(formPost("/oauth/authorize/decision", { ticket: view.ticket, decision: "approve", generate: "on" }, { origin: ISSUER }), ALICE);
  const code = new URL(decided.headers.get("location")!).searchParams.get("code")!;
  const token = (await (await tokenEndpoint(formPost("/oauth/token", {
    grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP_URL,
  }))).json()).access_token as string;
  const { POST } = await import("../app/mcp/route");
  const c = new Client({ name: "claude-ai", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: (url, init) => POST(new Request(url, init)), authProvider: { token: async () => token } }));
  return c;
}

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
const text = (r: ToolResult) => (r.content ?? []).map((x) => x.text ?? "").join("\n");

const errorCode = (r: ToolResult & { _meta?: Record<string, unknown> }) => (r._meta?.["com.cortexexam/error"] as { code?: string } | undefined)?.code;

test("sans annales ni format : « ~20 QCM » dans le focus ne décide pas du format — refus format_required, sans devis", async () => {
  const c = await client();
  const r = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-285", focus: "~20 QCM sur la révolution scientifique" } })) as ToolResult;
  assert.equal(r.isError, true);
  assert.equal(errorCode(r), "format_required");
  assert.match(text(r), /set_exam_format/);
  await c.close();
});

test("format demandé pour CET examen : QCM au nombre voulu et au tarif du QCM ; écrit borné à 12 exercices", async () => {
  const { costForJob } = await import("../lib/jobs");
  const { fromCenti } = await import("../lib/billing/credits");
  const c = await client();
  const r = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-285", format: "mcq", exercise_count: 15, focus: "Galilée" } })) as ToolResult;
  assert.equal(r.isError, undefined, text(r));
  const sc = r.structuredContent as { status: string; format: string; exercise_count: number; note: string | null; confirmation: { cost_credits: number } };
  assert.deepEqual([sc.status, sc.format, sc.exercise_count], ["confirmation_required", "mcq", 15]);
  assert.equal(sc.confirmation.cost_credits, fromCenti(costForJob("qcm", JSON.stringify({ count: 15, openCount: 0, focus: "Galilée" }))));
  assert.match(sc.note ?? "", /annales/);
  const tooMany = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-285", format: "written", exercise_count: 20 } })) as ToolResult;
  assert.equal(errorCode(tooMany), "invalid_input");
  // « written » sur un cours au format inconnu : devis d'un écrit, et la demande voyage dans la cible du job
  // (sans elle, le lancement relirait le format du cours, inconnu, et refuserait après confirmation).
  const written = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-285", format: "written", exercise_count: 3 } })) as ToolResult;
  assert.equal(written.isError, undefined, text(written));
  const w = written.structuredContent as { format: string; exercise_count: number; confirmation: { cost_credits: number } };
  assert.deepEqual([w.format, w.exercise_count], ["written", 3]);
  assert.equal(w.confirmation.cost_credits, fromCenti(costForJob("exam", JSON.stringify({ count: 3, kind: "exercises" }))));
  await c.close();
});

test("HUM-285 au format déclaré (QCM, 20 questions) : devis pour 20 QCM au tarif du QCM, et la raison dans la réponse", async () => {
  const { costForJob } = await import("../lib/jobs");
  const { fromCenti } = await import("../lib/billing/credits");
  const { updateCourseRow } = await import("../db/courses-store");
  const { listCoursesOf, reloadCourses } = await import("../lib/courses");
  const hum = listCoursesOf(ALICE).find((x) => x.examCode === "HUM-285")!;
  await updateCourseRow(hum.id, ALICE, { exam_format: JSON.stringify({ kind: "qcm", questionCount: 20, durationMin: 45, language: null }) });
  await reloadCourses();
  const c = await client();
  const r = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-285", focus: "moitié Bendahan, moitié Cavallaro" } })) as ToolResult;
  assert.equal(r.isError, undefined, text(r));
  const sc = r.structuredContent as { status: string; format: string; exercise_count: number; note: string | null; confirmation: { cost_credits: number } };
  assert.deepEqual([sc.status, sc.format, sc.exercise_count], ["confirmation_required", "mcq", 20]);
  assert.match(sc.note ?? "", /annales/);
  assert.match(sc.note ?? "", /déclaré/, "la note dit d'où vient le format");
  const target = JSON.stringify({ count: 20, openCount: 0, focus: "moitié Bendahan, moitié Cavallaro" });
  assert.equal(sc.confirmation.cost_credits, fromCenti(costForJob("qcm", target)));
  assert.match(text(r), /annales/, "le résumé lu par le modèle le dit aussi");

  // Avec des annales : leur format fait la règle, une demande de QCM n'est pas appliquée — et c'est dit.
  const exam = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "MATH-101", focus: "QCM sur les séries", format: "mcq" } })) as ToolResult;
  const ex = exam.structuredContent as { format: string; exercise_count: number | null; note: string | null };
  assert.deepEqual([ex.format, ex.exercise_count], ["written", null], "avec annales : format réel");
  assert.match(ex.note ?? "", /annales/);
  await c.close();
});

test("get_job_status sur un examen QCM terminé : les questions et leurs options, les réponses seulement sur demande", async () => {
  const { runWithCourse } = await import("../db/client");
  const { runWithUser } = await import("../db/context");
  const { q } = await import("../db/q");
  const { getQcmExam } = await import("../lib/qcm");
  const jobs = await import("../lib/jobs");
  const { listCoursesOf } = await import("../lib/courses");
  const course = listCoursesOf(ALICE).find((x) => x.examCode === "HUM-285")!.id;
  const jobId = await runWithUser(ALICE, () => runWithCourse(course, async () => {
    await getQcmExam(0); // amorce le schéma QCM du cours
    const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
    for (const [idx, stem, options, correct] of [[0, "Qui a publié le Sidereus Nuncius ?", ["Galilée", "Kepler", "Newton"], [0]], [1, "En quelle année ?", ["1543", "1610", "1687"], [1]]] as const) {
      await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        examId, idx, "Galilée", "scq", stem, JSON.stringify(options), JSON.stringify(correct), "[]", "Publié à Venise en 1610.", 1);
    }
    const id = await jobs.createJob("qcm");
    await jobs.setJob(id, { status: "done", progress: 100, resultId: examId, resultPath: `/mock/${examId}` });
    return id;
  }));
  const c = await client();
  type Status = { exam: { questions: { statement: string; solution: string | null }[] } | null; job: { result_link: string | null } };
  const plain = (await c.callTool({ name: "get_job_status", arguments: { course: "HUM-285", job_id: jobId } })) as ToolResult;
  const sc = plain.structuredContent as Status;
  assert.equal(sc.exam?.questions.length, 2, text(plain));
  assert.match(sc.exam!.questions[0].statement, /Sidereus Nuncius[\s\S]*A\) Galilée[\s\S]*B\) Kepler/);
  assert.equal(sc.exam!.questions[0].solution, null, "pas de réponse sans include_solutions");
  assert.match(sc.job.result_link ?? "", /\/mock\//);
  const keys = ((await c.callTool({ name: "get_job_status", arguments: { course: "HUM-285", job_id: jobId, include_solutions: true } })) as ToolResult).structuredContent as Status;
  assert.match(keys.exam!.questions[1].solution ?? "", /B[\s\S]*1610/);
  await c.close();
});
