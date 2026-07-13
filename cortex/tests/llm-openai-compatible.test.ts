import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { openaiCompatibleProvider } from "../lib/llm/providers/openai-compatible";
import { LlmError } from "../lib/llm/types";

/**
 * Teste le provider openai-compatible contre un stub HTTP local :
 * forme de la requête (modèle mappé par env, response_format json_schema,
 * Authorization Bearer), parsing usage, erreurs 401/429/5xx, timeout.
 */

type Captured = { url: string; auth?: string; body: Record<string, unknown> };
let server: http.Server;
let port = 0;
let captured: Captured | null = null;
let scenario: (res: http.ServerResponse) => void = () => {};

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      captured = { url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw || "{}") };
      scenario(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL_OPUS;
});

function setEnv() {
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_API_KEY = "nim-test-key";
  process.env.LLM_MODEL_OPUS = "meta/llama-3.1-405b-instruct";
}

const okResponse = (text: string) =>
  JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  });

test("openai-compatible : forme de requête + mapping modèle env + usage", async () => {
  setEnv();
  scenario = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(okResponse("bonjour"));
  };
  const out = await openaiCompatibleProvider.complete({
    prompt: "Question ?",
    system: "Tu es concis.",
    model: "opus",
    maxTokens: 123,
    json: { schema: { type: "object", properties: { a: { type: "string" } } } },
    timeoutMs: 5_000,
  });
  assert.equal(out.text, "bonjour");
  assert.deepEqual(out.usage, { inputTokens: 11, outputTokens: 3 });
  assert.equal(out.model, "meta/llama-3.1-405b-instruct");

  assert.ok(captured);
  assert.equal(captured!.url, "/v1/chat/completions");
  assert.equal(captured!.auth, "Bearer nim-test-key");
  assert.equal(captured!.body.model, "meta/llama-3.1-405b-instruct");
  assert.equal(captured!.body.max_tokens, 123);
  const messages = captured!.body.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages[0], { role: "system", content: "Tu es concis." });
  assert.deepEqual(messages[1], { role: "user", content: "Question ?" });
  const rf = captured!.body.response_format as { type: string; json_schema: { schema: object } };
  assert.equal(rf.type, "json_schema");
  assert.ok(rf.json_schema.schema);
});

test("openai-compatible : 429 → LlmError RATE_LIMIT retryable", async () => {
  setEnv();
  scenario = (res) => { res.writeHead(429); res.end("slow down"); };
  await assert.rejects(
    openaiCompatibleProvider.complete({ prompt: "p", timeoutMs: 5_000 }),
    (e: unknown) => e instanceof LlmError && e.code === "RATE_LIMIT" && e.retryable
  );
});

test("openai-compatible : 401 → AUTH non retryable", async () => {
  setEnv();
  scenario = (res) => { res.writeHead(401); res.end("bad key"); };
  await assert.rejects(
    openaiCompatibleProvider.complete({ prompt: "p", timeoutMs: 5_000 }),
    (e: unknown) => e instanceof LlmError && e.code === "AUTH" && !e.retryable
  );
});

test("openai-compatible : timeout → LlmError TIMEOUT", async () => {
  setEnv();
  scenario = (res) => setTimeout(() => { res.writeHead(200); res.end(okResponse("tard")); }, 3_000);
  await assert.rejects(
    openaiCompatibleProvider.complete({ prompt: "p", timeoutMs: 150 }),
    (e: unknown) => e instanceof LlmError && e.code === "TIMEOUT"
  );
});

test("openai-compatible : vision base64 → content multimodal (image avant texte)", async () => {
  setEnv();
  scenario = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(okResponse("vu")); };
  await openaiCompatibleProvider.complete({
    prompt: "Décris l'image.",
    images: [{ mediaType: "image/png", base64: "QUJD" }],
    timeoutMs: 5_000,
  });
  const messages = captured!.body.messages as Array<{ role: string; content: unknown }>;
  const content = messages[0].content as Array<Record<string, unknown>>;
  assert.equal(content[0].type, "image_url");
  assert.deepEqual(content[0].image_url, { url: "data:image/png;base64,QUJD" });
  assert.deepEqual(content[1], { type: "text", text: "Décris l'image." });
});

test("openai-compatible : addDirs → UNSUPPORTED (vision par chemins impossible hors claude-code)", async () => {
  setEnv();
  await assert.rejects(
    openaiCompatibleProvider.complete({ prompt: "p", addDirs: ["/tmp/x"] }),
    (e: unknown) => e instanceof LlmError && e.code === "UNSUPPORTED"
  );
});

test("openai-compatible : LLM_BASE_URL absente → UNAVAILABLE", async () => {
  delete process.env.LLM_BASE_URL;
  await assert.rejects(
    openaiCompatibleProvider.complete({ prompt: "p" }),
    (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE"
  );
  assert.equal(openaiCompatibleProvider.available(), false);
});
