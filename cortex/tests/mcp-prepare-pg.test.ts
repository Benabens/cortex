/**
 * PRÉPARATION D'UN COURS PAR LE CONNECTEUR, EN VRAI POSTGRES — le chemin de prod :
 * create_course → add_course_source → prepare_course (devis puis confirmation), puis
 * le worker détaché (scripts/run-job.ts) et son sous-processus d'ingestion
 * (scripts/ingest.ts), qui ouvrent la même base.
 *
 * Régression du 27/10/2026 : l'ingestion lisait le cache des cours au chargement du
 * module, avant de l'avoir chargé. En SQLite le cache s'amorce tout seul ; en Postgres
 * (la prod) non : tout job de préparation ou d'ingestion échouait en 3 s, « Cache des
 * cours non chargé ». Les tests en PGlite ne le voient pas : la base en mémoire n'est
 * pas partagée avec le worker.
 *
 * Base réelle requise : CORTEX_TEST_PG_URL (nom contenant « test »), sinon sauté. Une
 * base DÉDIÉE est créée pour ce fichier puis supprimée : les autres fichiers de tests
 * tournent en parallèle et l'un d'eux vide la base partagée.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE_URL = process.env.CORTEX_TEST_PG_URL ?? "";
const baseDb = (() => { try { return new URL(BASE_URL).pathname.replace(/^\//, ""); } catch { return ""; } })();
const ENABLED = !!BASE_URL && /test/i.test(baseDb);
const skip = ENABLED ? false : "CORTEX_TEST_PG_URL absente (ou base sans « test » dans son nom)";
const DB = `cortextest_prepare_${process.pid}`;
const DB_URL = (() => { try { const u = new URL(BASE_URL); u.pathname = `/${DB}`; return u.toString(); } catch { return ""; } })();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-prepare-pg-"));

const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: DB_URL, MCP_ENABLED: "1", AUTH_URL: "https://cortex.test",
  BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "5", DAILY_GEN_QUOTA: "unlimited", DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited", MCP_RATE_LIMIT_PER_MIN: "unlimited",
  // Le moteur doit être « disponible » pour le devis ; le faux fournisseur répond 500,
  // donc le worker échoue APRÈS l'ingestion, à la détection du format.
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0",
};
if (ENABLED) Object.assign(process.env, ENV);

const ISSUER = "https://cortex.test";
const MCP_URL = `${ISSUER}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const USER = `usr_prepare_pg_${process.pid}`;

let llm: http.Server;

async function admin<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

before(async () => {
  if (!ENABLED) return;
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.statusCode = 500; res.end("{}"); }); });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${DB}"`));
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  if (!ENABLED) return;
  await new Promise((r) => llm.close(r));
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`));
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const formPost = (p: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISSUER}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });

/** Connexion OAuth complète, cases « Générer » et « Ajouter » cochées → jeton d'accès. */
async function accessToken(user: string): Promise<string> {
  const { registerEndpoint, prepareConsent, consentDecisionEndpoint, tokenEndpoint } = await import("../lib/oauth/routes");
  const reg = await (await registerEndpoint(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude (test)", redirect_uris: [REDIRECT] }),
  }))).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const view = await prepareConsent(new Request(`${ISSUER}/oauth/authorize`), new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP_URL, state: "s",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  }), user);
  if (view.kind !== "consent") throw new Error(`consentement attendu : ${JSON.stringify(view)}`);
  const decided = await consentDecisionEndpoint(formPost("/oauth/authorize/decision",
    { ticket: view.ticket, decision: "approve", generate: "on", write: "on" }, { origin: ISSUER }), user);
  const code = new URL(decided.headers.get("location")!).searchParams.get("code")!;
  const t = await (await tokenEndpoint(formPost("/oauth/token", {
    grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP_URL,
  }))).json();
  return t.access_token as string;
}

async function route(req: Request): Promise<Response> {
  const { POST, GET, DELETE } = await import("../app/mcp/route");
  return (req.method === "POST" ? POST : req.method === "GET" ? GET : DELETE)(req);
}

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
const text = (r: ToolResult) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

test("create_course → add_course_source → prepare_course confirmé : le worker ingère le cours (Postgres réel)", { skip, timeout: 180_000 }, async () => {
  const client = new Client({ name: "cortex-test", version: "1.0.0" }, { capabilities: {} });
  const token = await accessToken(USER);
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => route(new Request(url, init)), authProvider: { token: async () => token },
  }));
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;

  const created = await call("create_course", { name: "Histoire des sciences", code: "HUM-285" });
  assert.equal(created.isError, undefined, text(created));
  const course = (created.structuredContent as { course: { id: string } }).course.id;
  for (const [title, category, body] of [
    ["Final 2024", "past_exam", "# Examen final 2024\n\nExercice 1 : expliquez la controverse Zorglubienne de 1632."],
    ["Notes de cours", "notes", "Semaine 3 : la révolution copernicienne et le procès de Galilée."],
  ] as const) {
    const r = await call("add_course_source", { course, title, category, text: body });
    assert.equal(r.isError, undefined, text(r));
  }

  const quote = await call("prepare_course", { course });
  const token2 = (quote.structuredContent as { confirmation?: { confirmation_token: string } }).confirmation?.confirmation_token;
  assert.ok(token2, text(quote));
  const started = await call("prepare_course", { course, confirmation_token: token2 });
  assert.equal((started.structuredContent as { status: string }).status, "started", text(started));
  const jobId = (started.structuredContent as { job: { job_id: number } }).job.job_id;

  type Job = { status: string; progress_pct: number; step: string | null; error: string | null };
  let job: Job | null = null;
  for (const t0 = Date.now(); Date.now() - t0 < 150_000;) {
    job = ((await call("get_job_status", { course, job_id: jobId })).structuredContent as { job: Job }).job;
    if (job.status === "done" || job.status === "error" || job.status === "canceled") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(job && (job.status === "done" || job.status === "error"), `job non terminé : ${JSON.stringify(job)}`);
  assert.doesNotMatch(job.error ?? "", /Cache des cours/, "l'ingestion ne doit plus échouer sur le cache des cours");
  assert.ok(job.progress_pct >= 34, `ingestion non terminée : ${JSON.stringify(job)}`);
  assert.match(text(await call("search_course_materials", { course, query: "Zorglubienne" })), /Zorglubienne/);
  await client.close();
});
