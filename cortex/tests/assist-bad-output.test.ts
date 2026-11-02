/**
 * Assistance (drill, check-solution) quand le modèle répond du texte illisible —
 * le « mcp.assist_failed code=unknown » de CS-290 (01/11) : le SyntaxError de
 * l'ancien extractJson n'avait pas de code. Verrouillé :
 *  - la réponse est redemandée avec l'erreur (3 essais), en sortie structurée ;
 *  - après 3 échecs : erreur BAD_OUTPUT au message clair, côté app ET connecteur,
 *    et l'appel est REMBOURSÉ (notre défaut, l'utilisateur n'a rien reçu) ;
 *  - une panne du fournisseur garde son message clair et son débit (décision du lot 2).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-assist-bad-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "1";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

let reply: () => { status?: number; content?: string } = () => ({ content: "{}" });
let calls = 0;
const bodies: Record<string, unknown>[] = [];
let server: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls++;
      bodies.push(JSON.parse(body));
      const r = reply();
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(r.status ? "boom" : JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { calls = 0; bodies.length = 0; });

after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (route: string, body: unknown) =>
  new NextRequest(`http://cortex.test/api/${route}?course=cs-202`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

test("drill (app) : un énoncé avec bloc de code dans du ```json est lu, en sortie structurée", async () => {
  const { POST } = await import("../app/api/drill/route");
  const drill = { concept: "groupby", statement_html: "<p>Code :</p>\n```python\nprint(df.groupby(\"sex\").mean())\n```", hints: ["a", "b", "c", "d", "e"], solution_html: "<p>Moyenne par groupe.</p>" };
  reply = () => ({ content: "```json\n" + JSON.stringify(drill, null, 2) + "\n```" });
  const res = await POST(post("drill", { concept: "groupby" }));
  assert.equal(res.status, 200);
  const out = (await res.json()) as { drill: typeof drill };
  assert.equal(out.drill.statement_html, drill.statement_html);
  assert.equal(calls, 1);
  assert.ok(bodies[0].response_format, "le drill demande une sortie structurée");
});

test("drill (app) : 3 réponses illisibles → 502 au message clair, appel remboursé", async () => {
  const { POST } = await import("../app/api/drill/route");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  reply = () => ({ content: "Voici une question d'entraînement sur groupby." });
  const res = await POST(post("drill", { concept: "groupby" }));
  assert.equal(res.status, 502);
  const out = (await res.json()) as { error: string; code: string };
  assert.equal(out.code, "BAD_OUTPUT");
  assert.match(out.error, /illisible/);
  assert.equal(calls, 3, "redemandé avec l'erreur, 3 essais");
  assert.equal(await credits.getBalanceCenti("owner"), before, "notre défaut : rien ne reste débité");
});

test("check-solution (app) : réponse illisible → 502 clair et remboursé ; réponse valide lue", async () => {
  const { POST } = await import("../app/api/check-solution/route");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  reply = () => ({ content: "Correct !" });
  const bad = await POST(post("check-solution", { statement: "Que vaut 1+1 ?", answer: "2" }));
  assert.equal(bad.status, 502);
  assert.match(((await bad.json()) as { error: string }).error, /illisible/);
  assert.equal(await credits.getBalanceCenti("owner"), before);
  const verdict = { verdict: "correct", feedback: "Juste.", correct_solution: "2", criteria: [
    { label: "Calcule 1+1", points: 1, achieved: true, essential: true, justification: "2 est donné." },
    { label: "Donne le résultat", points: 1, achieved: true, essential: false, justification: "Résultat donné." },
  ] };
  reply = () => ({ content: "```json\n" + JSON.stringify(verdict) + "\n```" });
  const ok = await POST(post("check-solution", { statement: "Que vaut 1+1 ?", answer: "2" }));
  assert.equal(ok.status, 200);
  assert.ok(bodies.at(-1)!.response_format, "la correction demande une sortie structurée");
});

test("panne du fournisseur (app) : message clair, sans le texte brut du fournisseur", async () => {
  const { POST } = await import("../app/api/drill/route");
  reply = () => ({ status: 503 });
  const res = await POST(post("drill", { concept: "groupby" }));
  assert.equal(res.status, 502);
  const out = (await res.json()) as { error: string; code: string };
  assert.equal(out.code, "UPSTREAM");
  assert.match(out.error, /surchargé ou injoignable/);
  assert.doesNotMatch(out.error, /boom|HTTP 503/);
});

test("connecteur MCP : chaque cause a son message et son code, jamais « unknown »", async () => {
  const { runAssist } = await import("../lib/mcp/assist");
  const { LlmError } = await import("../lib/llm");
  const { ToolError } = await import("../lib/mcp/tool");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  const cases: [Error, RegExp][] = [
    [new LlmError("Le modèle a renvoyé une réponse illisible 3 fois de suite (x).", "BAD_OUTPUT"), /illisible[\s\S]*Rien n'a été débité/],
    [new LlmError("529 overloaded_error", "OVERLOADED", true), /surchargé ou injoignable/],
    [new LlmError("Request timed out", "TIMEOUT", true), /trop de temps/],
  ];
  for (const [err, msg] of cases) {
    await assert.rejects(runAssist("drill", async () => { throw err; }), (e: unknown) => e instanceof ToolError && e.code === "unavailable" && e.reason === (err as InstanceType<typeof LlmError>).code && msg.test(e.message) && !/529|overloaded_error|timed out/.test(e.message));
  }
  // BAD_OUTPUT rendu, pannes du fournisseur débitées (lot 2) : 2 appels de 0,1 crédit restent dus.
  assert.equal(await credits.getBalanceCenti("owner"), before - 20);
});
