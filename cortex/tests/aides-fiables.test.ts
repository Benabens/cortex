/**
 * AIDES FIABLES (chasse aux bugs du 22/11/2026) — correction (check_answer) et drill :
 *  - la correction pose son budget (12 000 tokens, effort moyen) au lieu du défaut des aides
 *    (6 000) ; coupée, elle n'est relancée qu'UNE fois avec une demande abrégée, jamais trois fois
 *    la même (même défaut que le drill avant #176) ;
 *  - check_answer refuse une réponse faite d'espaces (corrigée sans réponse et débitée avant) ;
 *  - un drill sans ses 5 indices ou sans corrigé est redemandé, pas livré ni facturé tel quel.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-aides-fiables-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory",
  AI_BUDGET_MARGIN: "unlimited", BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "3",
  DAILY_ASSIST_QUOTA: "unlimited", RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited",
  // Aucune place pour un worker détaché : le job drill reste en file et le test l'exécute lui-même.
  MAX_GLOBAL_ASSIST_JOBS: "0",
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0",
};
Object.assign(process.env, ENV);

const DRILL = {
  concept: "Bellman-Ford",
  statement_html: "<p>Graphe à 4 sommets, une arête de poids −2 : distances depuis s ?</p>",
  hints: ["Initialise.", "Relâche chaque arête.", "Répète n−1 fois.", "Regarde l'arête négative.", "Au 2e tour, d(c) passe de 5 à 3 par b."],
  solution_html: "<ol><li>d(s)=0.</li><li>Tour 1 : d(a)=1, d(b)=4.</li><li>Tour 2 : d(c)=3.</li><li>Pas de cycle négatif.</li></ol>",
};

type Reply = { content?: string; finish?: string; status?: number };
let replies: Reply[] = [];
let calls = 0;
const bodies: Array<{ max_tokens: number; messages: Array<{ role: string; content: string }> }> = [];
let server: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls++;
      bodies.push(JSON.parse(body));
      const r = replies.length > 1 ? replies.shift()! : (replies[0] ?? { content: "{}" });
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(r.status ? "boom" : JSON.stringify({
        choices: [{ message: { content: r.content ?? "" }, finish_reason: r.finish ?? "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { calls = 0; bodies.length = 0; replies = []; });

after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const userPrompt = (i: number) => bodies[i].messages.find((m) => m.role === "user")!.content;

const CHECK_OK = JSON.stringify({
  verdict: "correct", feedback: "Rien à redire.", correct_solution: "x = 4",
  criteria: [
    { label: "Pose 2x=8", points: 1, achieved: true, essential: true, justification: "Oui." },
    { label: "Trouve x=4", points: 1, achieved: true, essential: false, justification: "Oui." },
  ],
});
const CHECK_CUT: Reply = { content: '{"verdict":"partial","feedback":"La trace de Dijkstra', finish: "length" };

async function check(statement: string, answer: string) {
  const { runWithCourse } = await import("../db/client");
  const { runAssist } = await import("../lib/mcp/assist");
  const { checkSolution } = await import("../lib/check-solution");
  return runWithCourse("cs-202", () => runAssist("check-solution", () => checkSolution({ statement, answer, imageRel: null })));
}

test("correction : son budget est posé (12 000 tokens), pas le défaut des aides", async () => {
  replies = [{ content: CHECK_OK }];
  const r = await check("Résoudre 2x = 8.", "x = 4");
  assert.equal(r.verdict, "correct");
  assert.equal(calls, 1);
  assert.equal(bodies[0].max_tokens, 12_000);
});

test("correction coupée : UNE relance, abrégée et plus petite, puis livrée", async () => {
  replies = [CHECK_CUT, { content: CHECK_OK }];
  const r = await check("Trace Dijkstra sur ce graphe de 8 sommets.", "d(a)=3, d(b)=5…");
  assert.equal(r.verdict, "correct");
  assert.equal(calls, 2);
  assert.match(userPrompt(1), /TROP LONGUE/);
  assert.ok(bodies[1].max_tokens < bodies[0].max_tokens, "la relance demande moins");
});

test("correction coupée deux fois : erreur après 2 appels, pas 3 fois la même demande", async () => {
  replies = [CHECK_CUT];
  await assert.rejects(check("Trace Dijkstra sur ce graphe de 8 sommets.", "d(a)=3…"), /Nothing was charged/);
  assert.equal(calls, 2);
});

test("check_answer (connecteur) : une réponse faite d'espaces est refusée avant tout appel", async () => {
  const tool = (await import("../lib/mcp/tools/check-answer")).default;
  assert.equal(tool.input.safeParse({ statement: "Résoudre 2x = 8.", answer: "   \n  " }).success, false);
  assert.equal(tool.input.safeParse({ statement: "   ", answer: "x = 4" }).success, false);
  const ok = tool.input.safeParse({ statement: " Résoudre 2x = 8. ", answer: " x = 4 " });
  assert.ok(ok.success && ok.data.answer === "x = 4");
});

const drillPost = () =>
  new NextRequest("http://cortex.test/api/drill?course=cs-202", {
    method: "POST", headers: { "content-type": "application/json", "accept-language": "fr" }, body: JSON.stringify({ concept: "Bellman-Ford" }),
  });

for (const [what, bad] of [
  ["un seul indice", { ...DRILL, hints: ["Initialise."] }],
  ["indices absents", { ...DRILL, hints: undefined }],
  ["indices en chaîne", { ...DRILL, hints: "Initialise puis relâche." }],
  ["indices vides", { ...DRILL, hints: ["", " ", "a", "b", "c"] }],
  ["corrigé vide", { ...DRILL, solution_html: "   " }],
] as const) {
  test(`drill incomplet (${what}) : redemandé avec le motif, livré complet`, async () => {
    const { POST } = await import("../app/api/drill/route");
    replies = [{ content: JSON.stringify(bad) }, { content: JSON.stringify(DRILL) }];
    const res = await POST(drillPost());
    assert.equal(res.status, 200, await res.clone().text());
    const { drill } = (await res.json()) as { drill: typeof DRILL };
    assert.equal(calls, 2, "la réponse incomplète est redemandée");
    assert.match(userPrompt(1), /(5 indices|non vides)/);
    assert.equal(drill.hints.length, 5);
    assert.ok(drill.solution_html.trim());
  });
}
