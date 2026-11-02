/**
 * SORTIE STRUCTURÉE du provider anthropic (output_config.format json_schema),
 * testée contre un faux /v1/messages en SSE :
 *  - le schéma envoyé est rendu compatible (additionalProperties: false sur
 *    chaque objet, contraintes numériques / de longueur / de taille retirées) ;
 *    un objet libre (sans propriétés) ne peut pas l'être → texte libre ;
 *  - un 400 sur la sortie structurée retombe UNE fois en texte libre ;
 *  - une réponse coupée (max_tokens) ou refusée n'est jamais rendue comme du texte valide.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { anthropicProvider } from "../lib/llm/providers/anthropic-api";
import { LlmError } from "../lib/llm/types";

type Reply = { status?: number; text?: string; stop?: string };
let server: http.Server;
const bodies: Record<string, unknown>[] = [];
let replies: Reply[] = [];

function sse(res: http.ServerResponse, text: string, stop: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 40 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      const r = replies.shift() ?? {};
      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config.format.schema: unsupported" } }));
        return;
      }
      sse(res, r.text ?? '{"ok":true}', r.stop ?? "end_turn");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LLM_API_KEY = "sk-ant-test";
});

beforeEach(() => { bodies.length = 0; replies = []; });

after(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
});

const QCM_LIKE = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 4,
      items: {
        type: "object",
        properties: {
          stem: { type: "string", minLength: 10 },
          correct: { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 5 },
        },
        required: ["stem", "correct"],
      },
    },
  },
  required: ["items"],
};

test("le schéma envoyé est rendu compatible avec la sortie structurée", async () => {
  const out = await anthropicProvider.complete({ prompt: "p", model: "sonnet", json: { schema: QCM_LIKE } });
  assert.equal(out.text, '{"ok":true}');
  type Node = { additionalProperties?: boolean; minItems?: number; maxItems?: number; minLength?: number; minimum?: number; required?: string[]; properties: Record<string, Node>; items: Node };
  const format = (bodies[0].output_config as { format: { type: string; schema: Node } }).format;
  assert.equal(format.type, "json_schema");
  const s = format.schema;
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.items.minItems, undefined);
  const item = s.properties.items.items;
  assert.equal(item.additionalProperties, false);
  assert.equal(item.properties.stem.minLength, undefined);
  assert.equal(item.properties.correct.maxItems, undefined);
  assert.equal(item.properties.correct.items.minimum, undefined);
  assert.deepEqual(item.required, ["stem", "correct"]);
  assert.equal((QCM_LIKE.properties.items as Record<string, unknown>).minItems, 4, "le schéma de l'appelant n'est pas modifié");
});

test("un objet libre (sans propriétés) rend le schéma inutilisable : texte libre, effort gardé", async () => {
  const schema = { type: "object", properties: { spec: { type: "object", description: "libre" } }, required: [], additionalProperties: false };
  await anthropicProvider.complete({ prompt: "p", model: "sonnet", json: { schema, effort: "high" } });
  assert.deepEqual(bodies[0].output_config, { effort: "high" });
});

test("un 400 sur la sortie structurée retombe une fois en texte libre", async () => {
  replies = [{ status: 400 }, { text: '{"items":[]}' }];
  const out = await anthropicProvider.complete({ prompt: "p", model: "sonnet", json: { schema: QCM_LIKE } });
  assert.equal(out.text, '{"items":[]}');
  assert.equal(bodies.length, 2);
  assert.ok((bodies[0].output_config as { format?: unknown }).format);
  assert.equal(bodies[1].output_config, undefined);
});

test("un 400 sans sortie structurée n'est pas rejoué", async () => {
  replies = [{ status: 400 }];
  await assert.rejects(anthropicProvider.complete({ prompt: "p", model: "sonnet" }), (e: unknown) => e instanceof LlmError);
  assert.equal(bodies.length, 1);
});

test("réponse coupée par max_tokens → TRUNCATED, avec l'usage réel", async () => {
  replies = [{ text: '{"items":[{"stem":"abc', stop: "max_tokens" }];
  await assert.rejects(
    anthropicProvider.complete({ prompt: "p", model: "sonnet", maxTokens: 40 }),
    (e: unknown) => e instanceof LlmError && e.code === "TRUNCATED" && e.retryable === false && e.usage?.outputTokens === 40,
  );
});

test("refus du modèle → REFUSAL (pas un texte à parser)", async () => {
  replies = [{ text: "Je ne peux pas aider.", stop: "refusal" }];
  await assert.rejects(
    anthropicProvider.complete({ prompt: "p", model: "sonnet" }),
    (e: unknown) => e instanceof LlmError && e.code === "REFUSAL",
  );
});
