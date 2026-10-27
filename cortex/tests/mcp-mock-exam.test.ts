/**
 * EXAMEN BLANC SUR UN COURS SANS ANNALES — HUM-285 (27/10/2026) : sans annales, le
 * blueprint n'avait qu'un créneau, et une demande de « ~20 QCM » produisait UN exercice.
 * Désormais, sans annales, l'outil suit la demande : le format (QCM si `format: "mcq"`
 * ou si le focus le dit) et le nombre (`exercise_count`), avec un défaut raisonnable, et
 * il le dit dans sa réponse. Avec des annales, le format réel des examens reste la règle.
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

// ───────────────────────────── décision ─────────────────────────────

test("sans annales : le focus « ~20 QCM » donne 20 QCM (générateur QCM), et la réponse le dit", async () => {
  const { planMockExam } = await import("../lib/mcp/tools/generate-mock-exam");
  const p = planMockExam({ focus: "~20 QCM sur la révolution scientifique", hasPastExams: false });
  assert.ok(!("error" in p));
  assert.deepEqual([p.format, p.jobType, p.count], ["mcq", "qcm", 20]);
  assert.deepEqual(JSON.parse(p.target!), { count: 20, openCount: 0, focus: "~20 QCM sur la révolution scientifique" });
  assert.match(p.note ?? "", /annales/);
  assert.match(p.note ?? "", /20 QCM/);
});

test("sans annales : format et nombre demandés respectés ; défauts raisonnables sinon", async () => {
  const { planMockExam } = await import("../lib/mcp/tools/generate-mock-exam");
  const mcq = planMockExam({ format: "mcq", count: 15, focus: null, hasPastExams: false });
  assert.deepEqual(["error" in mcq ? null : [mcq.jobType, mcq.count]], [["qcm", 15]]);
  const written = planMockExam({ focus: "intégrales", hasPastExams: false });
  assert.deepEqual(["error" in written ? null : [written.format, written.jobType, written.count]], [["written", "exam", 6]]);
  assert.match("error" in written ? "" : written.note ?? "", /6 exercices/);
  const nine = planMockExam({ format: "written", count: 9, focus: null, hasPastExams: false });
  assert.deepEqual(["error" in nine ? null : nine.count], [9]);
  const tooMany = planMockExam({ format: "written", count: 20, focus: null, hasPastExams: false });
  assert.ok("error" in tooMany, "un examen écrit compte au plus 12 exercices");
});

test("avec des annales : le format réel reste la règle (un focus qui parle de QCM ne change rien), sauf format explicite", async () => {
  const { planMockExam } = await import("../lib/mcp/tools/generate-mock-exam");
  const p = planMockExam({ focus: "QCM sur les séries", hasPastExams: true });
  assert.deepEqual(["error" in p ? null : [p.format, p.jobType, p.count, p.note]], [["written", "exam", null, null]]);
  const explicit = planMockExam({ format: "mcq", focus: null, hasPastExams: true });
  assert.deepEqual(["error" in explicit ? null : explicit.jobType], ["qcm"]);
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

test("generate_mock_exam sur HUM-285 (sans annales) : devis pour 20 QCM au tarif du QCM, et la raison dans la réponse", async () => {
  const { costForJob } = await import("../lib/jobs");
  const { fromCenti } = await import("../lib/billing/credits");
  const c = await client();
  const r = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-285", focus: "~20 QCM sur la révolution scientifique" } })) as ToolResult;
  assert.equal(r.isError, undefined, text(r));
  const sc = r.structuredContent as { status: string; format: string; exercise_count: number; note: string | null; confirmation: { cost_credits: number } };
  assert.deepEqual([sc.status, sc.format, sc.exercise_count], ["confirmation_required", "mcq", 20]);
  assert.match(sc.note ?? "", /annales/);
  const target = JSON.stringify({ count: 20, openCount: 0, focus: "~20 QCM sur la révolution scientifique" });
  assert.equal(sc.confirmation.cost_credits, fromCenti(costForJob("qcm", target)));
  assert.match(text(r), /annales/, "le résumé lu par le modèle le dit aussi");

  const exam = (await c.callTool({ name: "generate_mock_exam", arguments: { course: "MATH-101", focus: "QCM sur les séries" } })) as ToolResult;
  const ex = exam.structuredContent as { format: string; exercise_count: number | null; note: string | null };
  assert.deepEqual([ex.format, ex.exercise_count, ex.note], ["written", null, null], "avec annales : format réel");
  await c.close();
});
