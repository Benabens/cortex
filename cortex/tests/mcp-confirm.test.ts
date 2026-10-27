/**
 * CONFIRMATION D'UNE ACTION PAYANTE — par `POST /mcp`, avec de vrais clients MCP v2.
 *
 * Décision de Ben (27/10/2026, 23h37) : claude.ai, Claude Desktop et Cowork annoncent
 * l'élicitation mais ne l'affichent pas — l'appel pendait puis expirait (230 s). Donc :
 *  - par défaut, PAS d'élicitation : devis exact + confirmation_token, Claude demande
 *    l'accord dans la conversation, puis rappelle avec le jeton ;
 *  - élicitation seulement pour les clients qui l'affichent (Claude Code, reconnu par
 *    clientInfo ; MCP_ELICITATION_CLIENTS), avec repli sur le devis quand une demande
 *    est restée plus de 30 s sans réponse ;
 *  - coût nul (le propriétaire) : lancement direct, ni devis ni dialogue.
 * Protections inchangées : rien ne part sans jeton (ou réponse) valide, à usage unique,
 * lié au compte, à l'outil et aux arguments.
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-confirm-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory", MCP_ENABLED: "1", AUTH_URL: "https://cortex.test",
  BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "0", DAILY_GEN_QUOTA: "unlimited", DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited", MCP_RATE_LIMIT_PER_MIN: "unlimited",
  CORTEX_OWNER_EMAIL: "ben@example.com",
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0",
};
Object.assign(process.env, ENV);
delete process.env.CORTEX_OWNER_USER_ID;
delete process.env.MCP_ELICITATION_CLIENTS;

const ISSUER = "https://cortex.test";
const MCP_URL = `${ISSUER}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OWNER = "usr_owner_confirm";
const ALICE = "usr_alice_confirm";

let llm: http.Server;
let llmCalls = 0;

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      llmCalls++;
      const drill = { concept: "intégrales", statement_html: "<p>Calcule I.</p>", hints: ["h1", "h2", "h3", "h4", "h5"], solution_html: "<p>Par parties.</p>" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(drill) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { authRun } = await import("../db/auth-store");
  const { insertCourse } = await import("../db/courses-store");
  const { buildCourseRow } = await import("../lib/course-create");
  for (const [id, email, code] of [[OWNER, "ben@example.com", "OWN-1"], [ALICE, "alice@example.com", "ALI-1"]]) {
    await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, id, email, id);
    await insertCourse(buildCourseRow({ name: `Cours ${code}`, code }, id));
  }
  await reloadCourses();
});

after(async () => {
  await new Promise((r) => llm.close(r));
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ───────────────────────────── harnais ─────────────────────────────

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

async function route(req: Request): Promise<Response> {
  const { POST, GET, DELETE } = await import("../app/mcp/route");
  return (req.method === "POST" ? POST : req.method === "GET" ? GET : DELETE)(req);
}

/**
 * Client 2026-07-28 qui DÉCLARE l'élicitation. `answer` = sa réponse ; "never" = il ne
 * l'affiche jamais (la promesse ne se résout pas : un appel qui en dépendrait pendrait).
 */
async function modernClient(name: string, token: string, answer: "accept" | "decline" | "never", dialogs: string[]): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } } as ConstructorParameters<typeof Client>[1]);
  client.setRequestHandler("elicitation/create", (r) => {
    dialogs.push(String((r.params as { message?: string }).message ?? ""));
    if (answer === "never") return new Promise(() => {});
    return Promise.resolve(answer === "accept" ? { action: "accept" as const, content: { confirm: true } } : { action: "decline" as const });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => route(new Request(url, init)), authProvider: { token: async () => token },
  }));
  return client;
}

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map((x) => x.text ?? "").join("\n");
const errorCode = (r: ToolResult) => (r._meta?.["com.cortexexam/error"] as { code?: string } | undefined)?.code;
const status = (r: ToolResult) => (r.structuredContent as { status?: string } | undefined)?.status;
const quoteOf = (r: ToolResult) => (r.structuredContent as { confirmation: { cost_credits: number; confirmation_token: string } }).confirmation;
const balance = async (u: string) => (await import("../lib/billing/credits")).getBalanceCenti(u);
const topUp = async (u: string, centi: number, ref: string) => (await import("../lib/billing/credits")).addTransaction(u, centi, "test", ref);

/** Appel brut en ère 2026-07-28, clientInfo et capacités au choix. */
async function modernRaw(token: string, clientName: string, params: Record<string, unknown>) {
  const res = await route(new Request(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": String(params.name),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: clientName, version: "1" },
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
        },
      },
    }),
  }));
  const raw = await res.text();
  return JSON.parse(raw.includes("data:") ? raw.split("data:").pop()!.trim() : raw) as {
    result?: { resultType?: string; structuredContent?: Record<string, unknown> }; error?: { message: string };
  };
}

// ───────────────────────────── tests ─────────────────────────────

test("client qui annonce l'élicitation sans l'afficher (claude.ai, Cowork) : devis + jeton tout de suite, jamais de dialogue ; le jeton lance", { timeout: 20_000 }, async () => {
  await topUp(ALICE, 100, "t:alice:1");
  for (const name of ["claude-ai", "Claude Desktop", "cowork"]) {
    const dialogs: string[] = [];
    const c = await modernClient(name, await tokenFor(ALICE), "never", dialogs);
    const before = await balance(ALICE);
    const calls = llmCalls;
    const quote = await call(c, "generate_drill", { course: "ALI-1", concept: `intégrales ${name}` });
    assert.equal(status(quote), "confirmation_required", `${name} : ${text(quote)}`);
    assert.equal(dialogs.length, 0, `${name} : aucun dialogue`);
    assert.equal(await balance(ALICE), before, "un devis ne débite rien");
    assert.equal(llmCalls, calls, "un devis n'appelle pas le modèle");
    const done = await call(c, "generate_drill", { course: "ALI-1", concept: `intégrales ${name}`, confirmation_token: quoteOf(quote).confirmation_token });
    assert.equal(status(done), "done", text(done));
    assert.equal(await balance(ALICE), before - 10);
    await c.close();
  }
});

test("Claude Code (affiche l'élicitation) : la personne confirme dans le dialogue, l'action part en un appel", async () => {
  await topUp(ALICE, 100, "t:alice:2");
  const dialogs: string[] = [];
  const c = await modernClient("claude-code", await tokenFor(ALICE), "accept", dialogs);
  const before = await balance(ALICE);
  const r = await call(c, "generate_drill", { course: "ALI-1", concept: "séries entières" });
  assert.equal(status(r), "done", text(r));
  assert.equal(dialogs.length, 1);
  assert.equal(await balance(ALICE), before - 10);
  await c.close();
});

test("Claude Code qui ne répond pas : moins de 30 s → nouvelle demande ; au-delà → repli sur le devis à jeton, rien de lancé", async (t) => {
  await topUp(ALICE, 100, "t:alice:3");
  const token = await tokenFor(ALICE);
  const before = await balance(ALICE);
  const args = { name: "generate_drill", arguments: { course: "ALI-1", concept: "équations différentielles" } };
  const first = await modernRaw(token, "claude-code", args);
  assert.equal(first.result?.resultType, "input_required", JSON.stringify(first).slice(0, 300));
  const soon = await modernRaw(token, "claude-code", args);
  assert.equal(soon.result?.resultType, "input_required", "dialogue encore en cours");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 31_000 });
  let late;
  try {
    late = await modernRaw(token, "claude-code", args);
  } finally {
    t.mock.timers.reset();
  }
  assert.notEqual(late.result?.resultType, "input_required", JSON.stringify(late).slice(0, 300));
  const sc = late.result?.structuredContent as { status: string; confirmation: { confirmation_token: string } };
  assert.equal(sc.status, "confirmation_required");
  assert.ok(sc.confirmation.confirmation_token);
  assert.equal(await balance(ALICE), before, "rien de lancé ni débité");
});

test("coût nul (propriétaire) : lancement direct, sans devis ni dialogue, quel que soit le client", { timeout: 20_000 }, async () => {
  for (const name of ["claude-ai", "claude-code"]) {
    const dialogs: string[] = [];
    const c = await modernClient(name, await tokenFor(OWNER), "never", dialogs);
    const r = await call(c, "generate_drill", { course: "OWN-1", concept: `suites ${name}` });
    assert.equal(status(r), "done", `${name} : ${text(r)}`);
    assert.equal(dialogs.length, 0);
    await c.close();
  }
  assert.equal(await balance(OWNER), 0);
});

test("parallèle, flux par défaut : deux appels → deux devis, rien de lancé ; un jeton rejoué en parallèle ne sert qu'une fois", { timeout: 20_000 }, async () => {
  await topUp(ALICE, 100, "t:alice:4");
  const c = await modernClient("claude-ai", await tokenFor(ALICE), "never", []);
  const before = await balance(ALICE);
  const calls = llmCalls;
  const quotes = await Promise.all([1, 2].map(() => call(c, "generate_drill", { course: "ALI-1", concept: "probabilités" })));
  assert.deepEqual(quotes.map(status), ["confirmation_required", "confirmation_required"]);
  assert.equal(llmCalls, calls);
  assert.equal(await balance(ALICE), before);
  const tok = quoteOf(quotes[0]).confirmation_token;
  const runs = await Promise.all([1, 2, 3].map(() => call(c, "generate_drill", { course: "ALI-1", concept: "probabilités", confirmation_token: tok })));
  assert.equal(runs.filter((r) => status(r) === "done").length, 1, "un jeton, une seule exécution");
  assert.equal(runs.filter((r) => errorCode(r) === "confirmation_invalid").length, 2);
  assert.equal(await balance(ALICE), before - 10);
  await c.close();
});
