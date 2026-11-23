/**
 * MODÈLE PAR SITE (décision de Ben du 23/11/2026) : Opus 5.5 pour le difficile (rédiger un énoncé
 * ou un corrigé, corriger une réponse, vérifier), Sonnet 5.5 pour le mécanique (extraction,
 * classement, OCR, plan, analyse d'un point faible). Verrouillé :
 *  - les alias se résolvent vers claude-opus-5-5 et claude-sonnet-5-5 sur l'API ;
 *  - un drill et une correction (aides) partent sur claude-opus-5-5 quand LLM_ALLOW_OPUS=1 —
 *    l'ancienne règle « une aide ne part jamais sur Opus » a coûté deux corrigés faux le 22/11 ;
 *  - les sites mécaniques demandent « sonnet », les sites difficiles « opus » ;
 *  - la grille de prix connaît Opus 5.5 et Sonnet 5.5 (sinon : tarif le plus cher, surcompté).
 *
 * Seam : lib/llm complete() sur le provider anthropic, faux /v1/messages en SSE. Aucun appel réel.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-modeles-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory",
  LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-test", LLM_ALLOW_OPUS: "1", LLM_MAX_RETRIES: "0",
  CORTEX_LLM_TEST_AUTH: "1",
};
Object.assign(process.env, ENV);
// Les ids viennent des défauts du code, pas d'une variable posée.
for (const k of ["LLM_MODEL_OPUS", "LLM_MODEL_SONNET", "LLM_MODEL_HAIKU"]) delete process.env[k];

const DRILL = {
  concept: "Arbre couvrant minimal",
  statement_html: "<p>Graphe à 4 sommets : arbre couvrant minimal par Kruskal ?</p>",
  hints: ["Trie les arêtes.", "Union-Find.", "Commence par la plus légère.", "Rejette ce qui ferme un cycle.", "(a,b) 1 puis (b,c) 2."],
  solution_html: "<ol><li>(a,b) 1.</li><li>(b,c) 2.</li><li>(c,d) 4 : poids 7.</li></ol>",
  course_terms: [],
};
const CHECK = {
  verdict: "partial", feedback: "Il manque la dernière arête.", correct_solution: "(a,b), (b,c), (c,d) : poids 7.",
  criteria: [{ label: "Arêtes de l'arbre", points: 5, achieved: false, essential: true, justification: "(c,d) manque." }],
};

let server: http.Server;
let reply = JSON.stringify(DRILL);
const bodies: Array<{ model: string; max_tokens: number; output_config?: { effort?: string } }> = [];

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => { bodies.push(JSON.parse(raw || "{}")); sse(res, reply); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
beforeEach(() => { bodies.length = 0; });
after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const asAssist = async <T,>(fn: () => Promise<T>) => {
  const { runWithLlmAuthorization } = await import("../lib/llm/authorization");
  const { runWithCourse } = await import("../db/client");
  return runWithCourse("cs-202", () => runWithLlmAuthorization({ kind: "assist", ref: "assist:test:1" }, fn));
};

test("alias : opus → claude-opus-5-5, sonnet → claude-sonnet-5-5 ; sans LLM_ALLOW_OPUS, opus reste sur Sonnet", async () => {
  const { mapModel } = await import("../lib/llm/config");
  assert.equal(mapModel("opus", "anthropic"), "claude-opus-5-5");
  assert.equal(mapModel("sonnet", "anthropic"), "claude-sonnet-5-5");
  process.env.LLM_ALLOW_OPUS = "0";
  try {
    assert.equal(mapModel("opus", "anthropic"), "claude-sonnet-5-5");
  } finally { process.env.LLM_ALLOW_OPUS = "1"; }
});

test("un drill (aide) part sur claude-opus-5-5 quand LLM_ALLOW_OPUS=1", async () => {
  reply = JSON.stringify(DRILL);
  const { generateDrill } = await import("../lib/drill");
  const d = await asAssist(() => generateDrill("Arbre couvrant minimal"));
  assert.equal(d.hints.length, 5);
  assert.ok(bodies.length >= 1);
  assert.equal(bodies[0].model, "claude-opus-5-5", "le drill rédige un corrigé : Opus");
  const { ASSIST_MAX_TOKENS_CAP } = await import("../lib/llm");
  assert.ok(bodies[0].max_tokens <= ASSIST_MAX_TOKENS_CAP, `réponse bornée (${bodies[0].max_tokens})`);
});

test("une correction (check_answer) part sur claude-opus-5-5 quand LLM_ALLOW_OPUS=1", async () => {
  reply = JSON.stringify(CHECK);
  const { checkSolution } = await import("../lib/check-solution");
  const r = await asAssist(() => checkSolution({ statement: "<p>Kruskal sur 4 sommets.</p>", answer: "(a,b) puis (b,c)." }));
  assert.equal(r.verdict, "partial");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "claude-opus-5-5", "corriger une réponse : Opus");
});

test("une aide mécanique (analyse d'un point faible) reste sur Sonnet, même si l'appelant demande Opus", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app/api/weaknesses/process/route.ts"), "utf8");
  assert.match(src, /const chosenModel = model === "haiku" \? "haiku" : "sonnet";/);
});

/** Sites MÉCANIQUES : jamais « opus ». Un nouveau site mécanique s'ajoute ici. */
const MECHANICAL = [
  "lib/qcm-facts.ts", "lib/intake.ts", "lib/course-plan.ts", "lib/exam-dna.ts", "lib/exam-index.ts",
  "lib/program.ts", "lib/conversation-mining.ts", "app/api/weaknesses/analyze/route.ts",
  "lib/format.ts", "lib/revision.ts",
];
/** Sites DIFFICILES : rédaction, correction, vérification. */
const HARD = ["lib/drill.ts", "lib/check-solution.ts", "lib/qcm.ts", "lib/verify.ts", "lib/blocks.ts", "lib/labs.ts", "lib/exam.ts"];

test("classement des sites : le mécanique demande sonnet, le difficile opus", () => {
  const root = path.join(__dirname, "..");
  for (const f of MECHANICAL) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(src, /model: "opus"|\?\? "opus"/, `${f} est mécanique : « sonnet »`);
    assert.match(src, /model: "sonnet"|\?\? "sonnet"/, `${f} appelle le modèle en « sonnet »`);
  }
  for (const f of HARD) assert.match(fs.readFileSync(path.join(root, f), "utf8"), /model: "opus"/, `${f} est difficile : « opus »`);
  // architect : P1-P3 difficiles, l'identification d'une image mécanique ; qcm-evidence : le second
  // regard hors cours est un classement, la réécriture des explications une rédaction.
  for (const f of ["lib/architect.ts", "lib/qcm-evidence.ts"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(src, /model: "opus"/);
    assert.match(src, /model: "sonnet"/);
  }
});

test("grille de prix : Opus 5.5 4/20 $ (cache 0,20/5), Sonnet 5.5 2/10 $ (cache 0,10/2,5), Opus 4.x inchangé", async () => {
  const { rateFor, estimateCostUsd } = await import("../lib/billing/usage");
  assert.deepEqual(rateFor("claude-opus-5-5"), { prefix: "claude-opus-5-5", inPerM: 4, outPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 });
  assert.deepEqual(rateFor("claude-sonnet-5-5"), { prefix: "claude-sonnet-5-5", inPerM: 2, outPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5 });
  assert.equal(rateFor("claude-opus-4-8").outPerM, 25);
  assert.equal(rateFor("claude-sonnet-5").cacheReadPerM, 0.2);
  // 10 k tokens de sortie Opus 5.5 = 0,20 $.
  assert.equal(Math.round(estimateCostUsd("claude-opus-5-5", 0, 10_000) * 100) / 100, 0.2);
});

test("effort des sites difficiles : défaut du code, LLM_HARD_EFFORT le règle, une valeur inconnue garde le défaut", async () => {
  const { hardTaskEffort, HARD_TASK_EFFORT_DEFAULT } = await import("../lib/llm/types");
  const prev = process.env.LLM_HARD_EFFORT;
  try {
    delete process.env.LLM_HARD_EFFORT;
    assert.equal(hardTaskEffort(), HARD_TASK_EFFORT_DEFAULT);
    process.env.LLM_HARD_EFFORT = " High ";
    assert.equal(hardTaskEffort(), "high");
    process.env.LLM_HARD_EFFORT = "max";
    assert.equal(hardTaskEffort(), HARD_TASK_EFFORT_DEFAULT, "max n'existe pas dans LlmEffort");
  } finally {
    if (prev === undefined) delete process.env.LLM_HARD_EFFORT; else process.env.LLM_HARD_EFFORT = prev;
  }
});
