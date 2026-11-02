/**
 * completeJson (lib/llm) : une réponse illisible est redemandée en renvoyant au
 * modèle l'erreur PRÉCISE — pas relancée à l'identique (même prompt = même
 * erreur, et même réponse en cache). 3 essais, puis une erreur BAD_OUTPUT claire.
 * Fournisseur simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-complete-json-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

type Reply = { content?: string; status?: number; finish?: string };
let replies: Reply[] = [];
const prompts: string[] = [];
let llm: http.Server;

before(async () => {
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      prompts.push(String((JSON.parse(body).messages as { content: string }[]).at(-1)?.content));
      const r = replies.shift() ?? { content: "{}" };
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(r.status ? "{}" : JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: r.finish ?? "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
});

beforeEach(() => { replies = []; prompts.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("réponse illisible → redemandée avec l'erreur précise, puis lue", async () => {
  const { completeJson } = await import("../lib/llm");
  replies = [{ content: "Voici les questions demandées, bonne révision !" }, { content: '{"items":[1,2]}' }];
  const out = await completeJson<{ items: number[] }>({ prompt: "Donne { items }." });
  assert.deepEqual(out, { items: [1, 2] });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].startsWith("Donne { items }."), "le prompt d'origine est gardé");
  assert.match(prompts[1], /n'était pas un JSON valide/);
  assert.match(prompts[1], /sans JSON/, "l'erreur du parseur est citée");
});

test("3 réponses illisibles → BAD_OUTPUT explicite, 3 appels exactement", async () => {
  const { completeJson, LlmError } = await import("../lib/llm");
  replies = [{ content: "non" }, { content: "toujours pas" }, { content: "{\"items\": [" }];
  await assert.rejects(
    completeJson({ prompt: "p" }),
    (e: unknown) => e instanceof LlmError && e.code === "BAD_OUTPUT" && /3 fois/.test(e.message) && !e.retryable,
  );
  assert.equal(prompts.length, 3);
});

test("forme invalide (check) → redemandée avec le motif", async () => {
  const { completeJson } = await import("../lib/llm");
  replies = [{ content: '{"other": true}' }, { content: '{"items": []}' }];
  const out = await completeJson<{ items: unknown[] }>(
    { prompt: "p" },
    { check: (v) => (Array.isArray((v as { items?: unknown }).items) ? null : "le champ items (tableau) manque") },
  );
  assert.deepEqual(out, { items: [] });
  assert.match(prompts[1], /le champ items \(tableau\) manque/);
});

test("réponse coupée (max_tokens) → redemandée plus concise", async () => {
  const { completeJson } = await import("../lib/llm");
  replies = [{ content: '{"items": [1, 2', finish: "length" }, { content: '{"items": [1]}' }];
  assert.deepEqual(await completeJson({ prompt: "p" }), { items: [1] });
  assert.match(prompts[1], /coupée/);
  assert.match(prompts[1], /concis/);
});

test("une erreur du fournisseur n'est pas un problème de format : remontée telle quelle, sans réessai ici", async () => {
  const { completeJson, LlmError } = await import("../lib/llm");
  replies = [{ status: 400 }];
  await assert.rejects(completeJson({ prompt: "p" }), (e: unknown) => e instanceof LlmError && e.code === "UPSTREAM");
  assert.equal(prompts.length, 1);
});
