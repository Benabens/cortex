import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { anthropicProvider } from "../lib/llm/providers/anthropic-api";
import { LlmError } from "../lib/llm/types";

/**
 * Teste le provider anthropic contre un stub /v1/messages en SSE (le provider
 * streame toujours, comme l'historique exam.ts callClaude) : modèle par défaut
 * claude-opus-4-8, output_config json_schema, thinking adaptive, ordre
 * image→texte, disponibilité pilotée par la clé.
 */

let server: http.Server;
let port = 0;
let captured: Record<string, unknown> | null = null;

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_test", type: "message", role: "assistant", model: "claude-opus-4-8",
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 21, output_tokens: 1 },
    },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      captured = JSON.parse(raw || "{}");
      if (req.url?.includes("/messages")) return sse(res, '{"topic":"ok"}');
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLM_API_KEY = "sk-ant-test";
});

after(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
});

test("anthropic : stream + modèle par défaut + output_config + thinking + images avant texte", async () => {
  // Déploiement v1 (RÈGLE D'OR coûts) : « opus » ne se résout vers Opus sur le
  // provider API payant que si LLM_ALLOW_OPUS=1 — ce test vérifie le mapping
  // historique SOUS ce flag ; le défaut économe (Sonnet) a son propre test.
  process.env.LLM_ALLOW_OPUS = "1";
  const out = await anthropicProvider.complete({
    prompt: "Analyse.",
    model: "opus",
    maxTokens: 2000,
    thinking: "adaptive",
    json: { schema: { type: "object" }, effort: "high" },
    images: [{ mediaType: "image/png", base64: "QUJD" }],
    timeoutMs: 5_000,
  });
  delete process.env.LLM_ALLOW_OPUS;
  assert.equal(out.text, '{"topic":"ok"}');
  assert.equal(out.model, "claude-opus-4-8"); // GEN_MODEL historique préservé (opt-in)
  assert.deepEqual(out.usage, { inputTokens: 21, outputTokens: 9 });

  assert.ok(captured);
  assert.equal(captured!.model, "claude-opus-4-8");
  assert.equal(captured!.max_tokens, 2000);
  assert.equal(captured!.stream, true);
  assert.deepEqual(captured!.thinking, { type: "adaptive" });
  assert.deepEqual(captured!.output_config, {
    format: { type: "json_schema", schema: { type: "object" } },
    effort: "high",
  });
  const messages = captured!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages[0].content[0].type, "image");
  assert.equal(messages[0].content[1].type, "text");
});

test("anthropic : clé absente → UNAVAILABLE avec message ANTHROPIC_API_KEY (mapping 400 de la route analyze)", async () => {
  const savedKey = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(anthropicProvider.available(), false);
    await assert.rejects(
      anthropicProvider.complete({ prompt: "p" }),
      (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE" && /ANTHROPIC_API_KEY/.test(e.message)
    );
  } finally {
    process.env.LLM_API_KEY = savedKey;
  }
});

test("anthropic : addDirs → UNSUPPORTED", async () => {
  await assert.rejects(
    anthropicProvider.complete({ prompt: "p", addDirs: ["/tmp/x"] }),
    (e: unknown) => e instanceof LlmError && e.code === "UNSUPPORTED"
  );
});
