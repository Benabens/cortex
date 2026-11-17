/**
 * UN SEUL APPEL CONÇOIT L'EXAMEN (voie des cours sans architecte) — bandes cs-202-ecrit du 16 au
 * 17/11 : un appel de conception coûte ≈ 12 k tokens fixes + ≈ 13,3 k par exercice ; le découpage
 * [2,2,1] payait le fixe trois fois, et 10 % des lots de 2 dépassaient 600 s (perdus, refaits
 * exercice par exercice). Délai et limite de sortie suivent la taille du lot.
 * Faux /v1/messages Anthropic (aucune dépense) : le faux modèle met un temps et une sortie
 * proportionnels au nombre d'exercices demandés, et rend une réponse coupée si la limite est trop basse.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lot-unique-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "sk-ant-test";
process.env.LLM_MAX_RETRIES = "0";

/** Temps du faux modèle par exercice demandé ; délai d'un lot de 2 posé à 2,5 fois ce temps. */
const MS_PER_EXERCISE = 400;
/** Sortie par exercice, queue haute du banc (lot de 2 : jusqu'à 62 k tokens). */
const TOKENS_PER_EXERCISE = 24_000;

const lots: { n: number; maxTokens: number }[] = [];
let llm: http.Server;

function sse(res: http.ServerResponse, text: string, cut: number | null) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: cut === null ? text : text.slice(0, 40) } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: cut === null ? "end_turn" : "max_tokens", stop_sequence: null }, usage: { output_tokens: cut ?? 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  delete process.env.CORTEX_USER;
  delete process.env.CORTEX_TEST_STUB_BATCH;
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { max_tokens?: number; messages: { content: { type: string; text?: string }[] }[] };
      const text = body.messages.flatMap((m) => m.content.map((c) => c.text ?? "")).join("\n");
      const m = /LES (\d+) EXERCICES À PRODUIRE/.exec(text);
      const n = m ? Number(m[1]) : 1;
      const limit = body.max_tokens ?? 0;
      lots.push({ n, maxTokens: limit });
      const reply = JSON.stringify({ questions: Array.from({ length: n }, (_, i) => ({
        category: "General", concept: `Exercice ${i + 1}`, statement_tex: String.raw`\subq{1.1}{Calcul}{10} Calculez $\det A$.`, solution_tex: "Réponse : 1.", points: 10,
      })) });
      setTimeout(() => { if (!res.destroyed) sse(res, reply, limit < n * TOKENS_PER_EXERCISE ? limit : null); }, n * MS_PER_EXERCISE);
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  process.env.CORTEX_BATCH_TIMEOUT_MS = String(MS_PER_EXERCISE * 2.5);
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { lots.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MAX_RETRIES", "LLM_BASE_URL", "CORTEX_BATCH_TIMEOUT_MS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("un examen de 5 exercices est conçu d'un seul appel, qui a le temps et la place de finir", async () => {
  const { runWithCourse } = await import("../db/client");
  const { generateExamViaClaudeCode } = await import("../lib/exam");
  const r = await runWithCourse("ml", () => generateExamViaClaudeCode({ count: 5, verify: false }));
  assert.equal(r.produced, 5);
  assert.deepEqual(lots.map((l) => l.n), [5], `appels de conception : ${JSON.stringify(lots)}`);
});
