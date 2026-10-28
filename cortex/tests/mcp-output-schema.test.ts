/**
 * SORTIES CONFORMES AU SCHÉMA PUBLIÉ — claude.ai valide `structuredContent` contre
 * l'`outputSchema` de `tools/list` et REJETTE la réponse au moindre écart (« data must
 * NOT have additional properties », 28/10/2026, generate_mock_exam lancé directement
 * pour le propriétaire). Chaque chemin de generate_mock_exam est validé ici, avec le
 * validateur des clients MCP (celui du SDK), contre le schéma réellement publié : devis (avec et sans annales), refus, lancement
 * après jeton, lancement direct du propriétaire, examen déjà en cours.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-schema-"));
// Un faux moteur LaTeX dans le PATH : les pré-checks d'examen passent, le lancement réel est atteint.
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fake-tex-"));
fs.writeFileSync(path.join(FAKE_BIN, "tectonic"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory", MCP_ENABLED: "1", AUTH_URL: "https://cortex.test",
  BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "20", DAILY_GEN_QUOTA: "unlimited", DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited", MCP_RATE_LIMIT_PER_MIN: "unlimited",
  CORTEX_OWNER_EMAIL: "ben@example.com",
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_MODEL_OPUS: "claude-sonnet-5",
};
const PATH_BEFORE = process.env.PATH;
Object.assign(process.env, ENV);
process.env.PATH = `${FAKE_BIN}${path.delimiter}${PATH_BEFORE}`;
delete process.env.CORTEX_OWNER_USER_ID;
delete process.env.MCP_ELICITATION_CLIENTS;

const ISSUER = "https://cortex.test";
const MCP_URL = `${ISSUER}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OWNER = "usr_owner_schema";
const ALICE = "usr_alice_schema";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { authRun } = await import("../db/auth-store");
  const { insertCourse } = await import("../db/courses-store");
  const { buildCourseRow } = await import("../lib/course-create");
  const { runWithCourse } = await import("../db/client");
  const { runWithUser } = await import("../db/context");
  const { q } = await import("../db/q");
  // Sans annale, un cours doit avoir un format (déclaré ici) pour qu'un examen blanc parte : sinon
  // generate_mock_exam refuse avant tout devis (format_required, lib/exam-format).
  for (const [user, email, courses] of [
    [OWNER, "ben@example.com", [["Histoire des sciences", "HUM-285", false, "qcm"], ["Philosophie", "HUM-300", false, "exercises"]]],
    [ALICE, "alice@example.com", [["Probabilités", "MATH-232", false, "qcm"], ["Analyse", "MATH-101", true, null], ["Algèbre", "MATH-111", false, "exercises"], ["Géométrie", "MATH-120", false, "exercises"]]],
  ] as const) {
    await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, user, email, user);
    for (const [name, code, withExams, kind] of courses) {
      const row = buildCourseRow({ name, code, ...(kind ? { examFormat: { kind } } : {}) }, user);
      await insertCourse(row);
      // Un passage indexé (le corpus n'est pas vide), et des annales pour MATH-101.
      await runWithUser(user, () => runWithCourse(row.id, async () => {
        const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`,
          withExams ? "final" : "note", withExams ? "Final 2024" : "Notes", withExams ? "refs/final-2024.pdf" : "/notes.md", 2024, 1);
        await q.insert(`INSERT INTO items (source_id, type, title, text, anchor) VALUES (?,?,?,?,?)`, sid, "note", "Cours 1", "Contenu du cours.", "#1");
      }));
    }
  }
  await reloadCourses();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of Object.keys(ENV)) delete process.env[k];
  process.env.PATH = PATH_BEFORE;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(FAKE_BIN, { recursive: true, force: true });
});

const formPost = (p: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISSUER}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });

async function tokenFor(user: string): Promise<string> {
  const { registerEndpoint, prepareConsent, consentDecisionEndpoint, tokenEndpoint } = await import("../lib/oauth/routes");
  const reg = await (await registerEndpoint(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude (test)", redirect_uris: [REDIRECT] }),
  }))).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const view = await prepareConsent(new Request(`${ISSUER}/oauth/authorize`), new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP_URL, state: "s",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  }), user);
  if (view.kind !== "consent") throw new Error(JSON.stringify(view));
  const decided = await consentDecisionEndpoint(formPost("/oauth/authorize/decision", { ticket: view.ticket, decision: "approve", generate: "on", write: "on" }, { origin: ISSUER }), user);
  const code = new URL(decided.headers.get("location")!).searchParams.get("code")!;
  return (await (await tokenEndpoint(formPost("/oauth/token", {
    grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP_URL,
  }))).json()).access_token as string;
}

async function client(user: string, name = "claude-ai", answer?: "decline"): Promise<Client> {
  const { POST } = await import("../app/mcp/route");
  const c = new Client({ name, version: "1.0.0" },
    (answer ? { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } } : { capabilities: {} }) as ConstructorParameters<typeof Client>[1]);
  if (answer) c.setRequestHandler("elicitation/create", async () => ({ action: answer }));
  const token = await tokenFor(user);
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: (url, init) => POST(new Request(url, init)), authProvider: { token: async () => token } }));
  return c;
}

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
const text = (r: ToolResult) => (r.content ?? []).map((x) => x.text ?? "").join("\n");

type Schema = Parameters<AjvJsonSchemaValidator["getValidator"]>[0];

/** Schéma de sortie tel que publié dans tools/list, compilé par le validateur des clients MCP. */
async function publishedValidator(c: Client, tool: string) {
  const listed = (await c.listTools()).tools.find((t) => t.name === tool);
  assert.ok(listed?.outputSchema, `${tool} publie un outputSchema`);
  const schema = listed.outputSchema as Schema;
  return { schema, validate: new AjvJsonSchemaValidator().getValidator(schema) };
}

function assertConforms(v: Awaited<ReturnType<typeof publishedValidator>>, r: ToolResult, what: string): void {
  assert.equal(r.isError, undefined, `${what} : ${text(r)}`);
  const res = v.validate(r.structuredContent);
  assert.ok(res.valid, `${what} : ${res.errorMessage} — ${JSON.stringify(r.structuredContent).slice(0, 400)}`);
}

test("generate_mock_exam : chaque chemin rend exactement le schéma publié", async () => {
  const alice = await client(ALICE);
  const v = await publishedValidator(alice, "generate_mock_exam");
  const call = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "generate_mock_exam", arguments: args }) as Promise<ToolResult>;

  // 1. Devis, cours SANS annales (note + format QCM).
  const mcqQuote = await call(alice, { course: "MATH-232", focus: "~20 QCM sur les lois usuelles" });
  assertConforms(v, mcqQuote, "devis QCM sans annales");
  // 2. Devis, cours AVEC annales (note nulle).
  assertConforms(v, await call(alice, { course: "MATH-101", focus: "séries" }), "devis avec annales");
  // 3. Lancement après jeton (compte ordinaire).
  const quote = await call(alice, { course: "MATH-111", exercise_count: 3 });
  const token = (quote.structuredContent as { confirmation: { confirmation_token: string } }).confirmation.confirmation_token;
  const started = await call(alice, { course: "MATH-111", exercise_count: 3, confirmation_token: token });
  assert.equal((started.structuredContent as { status?: string }).status, "started", text(started));
  assertConforms(v, started, "lancement après jeton");
  // 4. Examen déjà en cours (réutilisé).
  assertConforms(v, await call(alice, { course: "MATH-111" }), "déjà en cours");
  await alice.close();

  // 5. Refus dans le dialogue (Claude Code).
  const refusing = await client(ALICE, "claude-code", "decline");
  const refused = await call(refusing, { course: "MATH-120" });
  assert.equal((refused.structuredContent as { status?: string }).status, "declined", text(refused));
  assertConforms(v, refused, "refus");
  await refusing.close();

  // 6. Lancement DIRECT du propriétaire, sans annales, 12 exercices + focus (le cas vu sur claude.ai).
  const owner = await client(OWNER);
  const direct = await call(owner, { course: "HUM-285", exercise_count: 12, focus: "la révolution copernicienne" });
  assert.equal((direct.structuredContent as { status?: string }).status, "started", text(direct));
  assertConforms(v, direct, "lancement direct du propriétaire");
  await owner.close();
});

test("diagnostic : la réponse du 28/10 contre le schéma d'AVANT la #49 (sans format ni note) donne exactement les 2 propriétés en trop", async () => {
  const owner = await client(OWNER);
  const { schema } = await publishedValidator(owner, "generate_mock_exam");
  const old = structuredClone(schema) as Schema & { properties: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
  delete old.properties.format;
  delete old.properties.note;
  old.required = (old.required ?? []).filter((k) => k !== "format" && k !== "note");
  old.additionalProperties = false; // ce que publiait le serveur avant ce correctif
  const r = (await owner.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-300", exercise_count: 12, focus: "Descartes" } })) as ToolResult;
  const res = new AjvJsonSchemaValidator().getValidator(old)(r.structuredContent);
  assert.equal(res.valid, false);
  assert.equal((res.errorMessage?.match(/must NOT have additional properties/g) ?? []).length, 2, res.errorMessage);
  await owner.close();
});

test("compatibilité : un client qui a gardé un schéma publié AVANT l'ajout d'un champ de sortie accepte encore la réponse", async () => {
  const owner = await client(OWNER);
  const tools = (await owner.listTools()).tools;
  for (const t of tools) {
    const schema = t.outputSchema as (Schema & { additionalProperties?: unknown }) | undefined;
    assert.ok(schema, `${t.name} publie un outputSchema`);
    assert.notEqual(schema.additionalProperties, false, `${t.name} : le schéma publié doit tolérer un champ ajouté plus tard`);
  }
  // Le cas du 28/10 rejoué : une version du schéma sans « format » ni « note », publiée tolérante.
  const { schema } = await publishedValidator(owner, "generate_mock_exam");
  const older = structuredClone(schema) as Schema & { properties: Record<string, unknown>; required?: string[] };
  delete older.properties.format;
  delete older.properties.note;
  older.required = (older.required ?? []).filter((k) => k !== "format" && k !== "note");
  const r = (await owner.callTool({ name: "generate_mock_exam", arguments: { course: "HUM-300", exercise_count: 12, focus: "Kant" } })) as ToolResult;
  const res = new AjvJsonSchemaValidator().getValidator(older)(r.structuredContent);
  assert.ok(res.valid, res.errorMessage);
  await owner.close();
});
