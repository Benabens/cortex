/**
 * CONNECTEUR MCP — désigner le bon cours et suivre le bon job (chasse aux bugs du 22/11/2026).
 *
 * Un compte réel a plusieurs cours ; les job_id sont numérotés par cours (le job 1 existe dans
 * chacun). Verrouillé ici, par `POST /mcp` avec un vrai client MCP sur Postgres (PGlite) :
 *  - un morceau du nom suffit (« enjeux mondiaux »), un nom qui en désigne plusieurs est
 *    signalé au lieu d'en prendre un au hasard, l'erreur « introuvable » liste les cours ;
 *  - create_course refuse « CS 250 » quand « CS-250 » existe (sinon deux cours au même code) ;
 *  - get_job_status(job_id) sans cours retrouve le cours du job, ou dit lesquels l'ont ;
 *  - la consigne de suivi des outils payants porte le cours ;
 *  - un drill en cours compte comme « en cours », avec SA notion.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

process.env.DB_DRIVER = "postgres";
process.env.AI_BUDGET_MARGIN = "unlimited";
process.env.DATABASE_URL = "pglite://memory";
process.env.MCP_ENABLED = "1";
process.env.AUTH_URL = "https://cortex.test";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "5";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
process.env.CORTEX_SANDBOX = "none";

const ISSUER = "https://cortex.test";
const MCP_URL = `${ISSUER}/mcp`;
const EVE = "usr_eve_mcp_jobs";
const ENV_KEYS = ["DB_DRIVER", "AI_BUDGET_MARGIN", "DATABASE_URL", "MCP_ENABLED", "AUTH_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS",
  "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS", "LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "CORTEX_SANDBOX"];

/** id de cours par code (le cours sans code : « physique »). */
const ids: Record<string, string> = {};

before(async () => {
  delete process.env.CORTEX_USER;
  const { insertCourse } = await import("../db/courses-store");
  const { buildCourseRow } = await import("../lib/course-create");
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  for (const [name, code] of [["Algorithms", "CS-250"], ["Computer Systems", "CS-202"], ["Enjeux mondiaux de la société numérique", "HUM-285"], ["Physique générale", ""]]) {
    const row = buildCourseRow({ name, code }, EVE);
    await insertCourse(row);
    ids[code || "physique"] = row.id;
  }
  await reloadCourses();

  const { runWithCourse } = await import("../db/client");
  const { runWithUser } = await import("../db/context");
  const { createJob, setJob, insertReservedJob } = await import("../lib/jobs");
  // Job 1 dans trois cours ; le job 2 n'existe qu'en CS-250 (un drill qui s'écrit, sur Max-flow).
  for (const code of ["CS-250", "CS-202", "HUM-285"]) {
    await runWithUser(EVE, () => runWithCourse(ids[code], async () => {
      const id = await createJob("ingest");
      await setJob(id, { status: "done", progress: 100 });
    }));
  }
  await runWithUser(EVE, () => runWithCourse(ids["CS-250"], () => insertReservedJob("drill", JSON.stringify({ concept: "Max-flow / min-cut" }), "job:test:drill")));
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ENV_KEYS) delete process.env[k];
});

const formPost = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISSUER}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });

async function tokenFor(user: string): Promise<string> {
  const { registerEndpoint, prepareConsent, consentDecisionEndpoint, tokenEndpoint } = await import("../lib/oauth/routes");
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (await registerEndpoint(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude (test)", redirect_uris: [redirect] }),
  }))).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const view = await prepareConsent(new Request(`${ISSUER}/oauth/authorize`), new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: MCP_URL,
  }), user);
  if (view.kind !== "consent") throw new Error(`consentement attendu : ${JSON.stringify(view)}`);
  const decided = await consentDecisionEndpoint(formPost("/oauth/authorize/decision",
    { ticket: view.ticket, decision: "approve", generate: "on", write: "on" }, { origin: ISSUER }), user);
  const code = new URL(decided.headers.get("location")!).searchParams.get("code")!;
  const t = await (await tokenEndpoint(formPost("/oauth/token", {
    grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: MCP_URL,
  }))).json();
  return t.access_token;
}

async function connect(token: string): Promise<Client> {
  const { POST } = await import("../app/mcp/route");
  const client = new Client({ name: "cortex-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => POST(new Request(url, init)),
    authProvider: { token: async () => token },
  }));
  return client;
}

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const errorCode = (r: ToolResult) => (r._meta?.["com.cortexexam/error"] as { code?: string } | undefined)?.code;
const courseOf = (r: ToolResult) => (r.structuredContent as { course: { id: string } }).course.id;

let client: Client;
test("connexion", async () => { client = await connect(await tokenFor(EVE)); });

test("cours : un morceau du nom, sans accents ni casse, suffit quand un seul cours le contient", async () => {
  const r = await call(client, "get_weak_points", { course: "enjeux mondiaux" });
  assert.equal(r.isError, undefined, text(r));
  assert.equal(courseOf(r), ids["HUM-285"]);
  assert.equal(courseOf(await call(client, "get_weak_points", { course: "SOCIETE NUMERIQUE" })), ids["HUM-285"]);
  assert.equal(courseOf(await call(client, "get_weak_points", { course: "cs–250" })), ids["CS-250"], "un tiret long vaut un tiret");
});

test("cours : un nom qui désigne plusieurs cours est signalé avec les candidats, jamais résolu au hasard", async () => {
  const r = await call(client, "get_weak_points", { course: "CS 2" });
  assert.equal(errorCode(r), "invalid_input", text(r));
  assert.match(text(r), /matches 2 courses/);
  assert.match(text(r), /CS-250/);
  assert.match(text(r), /CS-202/);
});

test("cours : introuvable → l'erreur liste les cours du compte (pas d'aller-retour par list_courses)", async () => {
  const r = await call(client, "get_weak_points", { course: "Quantum computing" });
  assert.equal(errorCode(r), "not_found");
  assert.match(text(r), /HUM-285/);
  assert.match(text(r), new RegExp(`id ${ids.physique}`));
});

test("cours : une référence vide après normalisation (« - ») ne désigne pas le cours sans code", async () => {
  const r = await call(client, "get_weak_points", { course: "-" });
  assert.equal(errorCode(r), "not_found", text(r));
});

test("create_course : « cs 250 » est le même code que « CS-250 » → refusé, pas de second cours au même code", async () => {
  const r = await call(client, "create_course", { name: "Algorithmique bis", code: "cs 250" });
  assert.equal(errorCode(r), "conflict", text(r));
  const list = (await call(client, "list_courses")).structuredContent as { courses: unknown[] };
  assert.equal(list.courses.length, 4);
});

test("get_job_status(job_id) sans cours : un job présent dans un seul cours y est retrouvé", async () => {
  const r = await call(client, "get_job_status", { job_id: 2 });
  assert.equal(r.isError, undefined, text(r));
  assert.equal(courseOf(r), ids["CS-250"]);
  assert.equal((r.structuredContent as { job: { type: string } }).job.type, "drill");
});

test("get_job_status(job_id) sans cours : un job_id présent dans plusieurs cours → les candidats, avec type et date", async () => {
  const r = await call(client, "get_job_status", { job_id: 1 });
  assert.equal(errorCode(r), "invalid_input", text(r));
  assert.match(text(r), /numbered per course/);
  assert.match(text(r), /3 courses/);
  assert.match(text(r), /ingest/);
  const none = await call(client, "get_job_status", { job_id: 77 });
  assert.equal(errorCode(none), "not_found");
});

test("get_job_status sans job_id : un drill qui s'écrit est « en cours » (sinon l'assistant le relance)", async () => {
  const r = await call(client, "get_job_status", { course: "CS-250" });
  assert.equal(r.isError, undefined, text(r));
  const sc = r.structuredContent as { active: { type: string; job_id: number } | null };
  assert.equal(sc.active?.type, "drill");
  assert.doesNotMatch(text(r), /No generation is running/);
});

test("generate_drill pendant un drill : rend le job en cours AVEC sa notion, et un suivi qui nomme le cours", async () => {
  const r = await call(client, "generate_drill", { course: "CS-250", concept: "Dijkstra" });
  assert.equal(r.isError, undefined, text(r));
  const sc = r.structuredContent as { status: string; concept: string; job: { job_id: number; track_with: string } };
  assert.equal(sc.status, "already_running");
  assert.equal(sc.concept, "Max-flow / min-cut", "la notion du drill réellement en cours, pas celle demandée");
  assert.match(sc.job.track_with, new RegExp(`course="${ids["CS-250"]}"`));
  assert.match(text(r), new RegExp(`course="${ids["CS-250"]}"`));
});

test("fin", async () => { await client.close(); });
