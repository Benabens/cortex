import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { withRetry } from "../lib/llm/retry";
import { anthropicProvider } from "../lib/llm/providers/anthropic-api";
import { LlmError } from "../lib/llm/types";

/**
 * Robustesse du provider anthropic face aux pannes de l'API, contre un stub local :
 *  - les réessais sont ceux de Cortex seuls (withRetry, LLM_MAX_RETRIES), pas en plus ceux du SDK ;
 *  - `timeoutMs` borne l'appel entier, flux compris (le timeout du SDK s'arrête aux en-têtes) ;
 *  - une erreur envoyée DANS le flux (overloaded_error après le 200) est réessayable.
 */

type Mode = "overloaded" | "reset" | "slow" | "midstream-overloaded" | "midstream-invalid";
let server: http.Server;
let mode: Mode = "overloaded";
let requests = 0;

const send = (res: http.ServerResponse, event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function start(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  send(res, "message_start", {
    type: "message_start",
    message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } },
  });
  send(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
}

before(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      if (mode === "reset") return void req.socket.destroy();
      if (mode === "overloaded") {
        res.writeHead(529, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        return;
      }
      start(res);
      if (mode === "slow") {
        // Le flux vit (pings), mais la réponse ne finit jamais avant la fin du test.
        const t = setInterval(() => send(res, "ping", { type: "ping" }), 50);
        res.on("close", () => clearInterval(t));
        return;
      }
      send(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"a":' } });
      const type = mode === "midstream-overloaded" ? "overloaded_error" : "invalid_request_error";
      send(res, "error", { type: "error", error: { type, message: type } });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LLM_API_KEY = "sk-ant-test";
});

beforeEach(() => { requests = 0; });

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
});

test("anthropic : un 529 n'est envoyé qu'une fois par tentative de Cortex (pas de réessais cachés du SDK)", async () => {
  mode = "overloaded";
  await assert.rejects(
    withRetry(() => anthropicProvider.complete({ prompt: "x", model: "sonnet", timeoutMs: 5_000 }), { retries: 2, baseMs: 1 }),
    (e: unknown) => e instanceof LlmError && e.code === "OVERLOADED",
  );
  // 3 tentatives de withRetry → 3 requêtes. Avant : 9 (chaque tentative réessayait 2 fois en douce,
  // avec l'attente du SDK, sans ligne d'usage ni contrôle du plafond de la réservation).
  assert.equal(requests, 3);
});

test("anthropic : connexion coupée avant la réponse → NETWORK réessayable (les réessais du SDK n'y sont plus)", async () => {
  mode = "reset";
  await assert.rejects(
    withRetry(() => anthropicProvider.complete({ prompt: "x", model: "sonnet", timeoutMs: 5_000 }), { retries: 2, baseMs: 1 }),
    (e: unknown) => e instanceof LlmError && e.code === "NETWORK" && e.retryable === true,
  );
  assert.equal(requests, 3);
});

test("anthropic : timeoutMs borne aussi le flux (réponse qui ne finit pas)", async () => {
  mode = "slow";
  const t0 = Date.now();
  await assert.rejects(
    anthropicProvider.complete({ prompt: "x", model: "sonnet", timeoutMs: 400 }),
    (e: unknown) => e instanceof LlmError && e.code === "TIMEOUT",
  );
  assert.ok(Date.now() - t0 < 3_000, `rendu après ${Date.now() - t0} ms`);
});

test("anthropic : overloaded_error au milieu du flux → réessayable, et l'estimation d'usage est gardée", async () => {
  mode = "midstream-overloaded";
  await assert.rejects(
    anthropicProvider.complete({ prompt: "x", model: "sonnet", timeoutMs: 5_000 }),
    (e: unknown) => e instanceof LlmError && e.retryable === true && e.code === "STREAM_INTERRUPTED",
  );
});

test("anthropic : une autre erreur dans le flux reste définitive", async () => {
  mode = "midstream-invalid";
  await assert.rejects(
    anthropicProvider.complete({ prompt: "x", model: "sonnet", timeoutMs: 5_000 }),
    (e: unknown) => e instanceof LlmError && e.retryable === false,
  );
});
