/**
 * Bande LLM du banc (LLM_TAPE) : `record:<fichier>` garde chaque réponse du modèle,
 * `replay:<fichier>` les rejoue sans aucun appel. Un prompt qui a bougé depuis
 * l'enregistrement reçoit la réponse du même rang au même site d'appel (le moteur
 * reste exercé de bout en bout, le décompte le dit) ; un site jamais enregistré
 * échoue bruyamment. Fournisseur simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-llm-tape-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

let replies: { content?: string; status?: number }[] = [];
let served = 0;
let llm: http.Server;

before(async () => {
  llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      served++;
      const r = replies.shift() ?? { content: "?" };
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(r.status ? "{}" : JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
});

beforeEach(() => { replies = []; served = 0; delete process.env.LLM_TAPE; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "LLM_TAPE"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function poseQuestion(prompt: string): Promise<string> {
  const { completeText } = await import("../lib/llm");
  return completeText({ prompt });
}

async function corrige(prompt: string): Promise<string> {
  const { completeText } = await import("../lib/llm");
  return completeText({ prompt });
}

function tapeFile(name: string): string {
  return path.join(tmp, `${name}.tape.jsonl`);
}

test("enregistrée puis rejouée : mêmes réponses, aucun appel au fournisseur", async () => {
  const file = tapeFile("rejeu");
  process.env.LLM_TAPE = `record:${file}`;
  replies = [{ content: "réponse 1" }, { content: "réponse 2" }];
  assert.equal(await poseQuestion("Question A"), "réponse 1");
  assert.equal(await poseQuestion("Question B"), "réponse 2");
  assert.equal(served, 2);

  process.env.LLM_TAPE = `replay:${file}`;
  assert.equal(await poseQuestion("Question B"), "réponse 2");
  assert.equal(await poseQuestion("Question A"), "réponse 1");
  assert.equal(served, 2, "le rejeu n'appelle pas le fournisseur");
});

test("chaque appel enregistré garde de quoi estimer le coût : tailles, empreinte du système, redemande JSON", async () => {
  const file = tapeFile("mesures");
  process.env.LLM_TAPE = `record:${file}`;
  replies = [{ content: "pas du json" }, { content: '{"ok":true}' }];
  const { completeJson } = await import("../lib/llm");
  await completeJson({ prompt: "Donne {ok}.", system: "Tu es un examinateur." });
  const [first, second] = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { promptChars: number; systemChars: number; systemHash?: string; jsonRetry?: boolean; at: number });
  assert.equal(first.systemChars, "Tu es un examinateur.".length);
  assert.ok(first.systemHash && first.systemHash === second.systemHash);
  assert.deepEqual([!!first.jsonRetry, !!second.jsonRetry], [false, true]);
  assert.ok(second.at >= first.at);
});

test("prompt modifié depuis l'enregistrement : réponse du même rang au même site, signalée", async () => {
  const file = tapeFile("derive");
  process.env.LLM_TAPE = `record:${file}`;
  replies = [{ content: "premier lot" }, { content: "second lot" }];
  await poseQuestion("Lot 1 du cours");
  await poseQuestion("Lot 2 du cours");

  process.env.LLM_TAPE = `replay:${file}`;
  assert.equal(await poseQuestion("Lot 1 du cours, consigne retouchée"), "premier lot");
  assert.equal(await poseQuestion("Lot 2 du cours"), "second lot");
  const uses = fs.readFileSync(`${file}.replay.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { site: string; match: string });
  assert.deepEqual(uses.map((u) => u.match), ["rank", "exact"]);
  assert.equal(uses[0].site, "poseQuestion");
  assert.equal(served, 2, "seuls les deux appels enregistrés ont touché le fournisseur");
});

test("site jamais enregistré : le rejeu échoue bruyamment, sans appeler le fournisseur", async () => {
  const file = tapeFile("trou");
  process.env.LLM_TAPE = `record:${file}`;
  replies = [{ content: "ok" }];
  await poseQuestion("Q");

  process.env.LLM_TAPE = `replay:${file}`;
  const { LlmError } = await import("../lib/llm");
  await assert.rejects(corrige("Corrige Q"), (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE" && /bande/i.test(e.message) && /corrige/.test(e.message));
  assert.equal(served, 1);
});

test("une erreur du fournisseur enregistrée est rejouée avec son code", async () => {
  const file = tapeFile("erreur");
  process.env.LLM_TAPE = `record:${file}`;
  replies = [{ status: 503 }];
  const { LlmError } = await import("../lib/llm");
  let code: string | undefined;
  await assert.rejects(poseQuestion("Q"), (e: unknown) => { code = (e as InstanceType<typeof LlmError>).code; return e instanceof LlmError; });

  process.env.LLM_TAPE = `replay:${file}`;
  await assert.rejects(poseQuestion("Q"), (e: unknown) => e instanceof LlmError && e.code === code);
  assert.equal(served, 1);
});

test("en rejeu, le moteur est disponible même sans fournisseur joignable (CI sans CLI ni clé)", async () => {
  const { llmAvailable, llmUnavailableReason } = await import("../lib/llm");
  const saved = process.env.LLM_BASE_URL;
  delete process.env.LLM_BASE_URL;
  try {
    assert.equal(llmAvailable(), false, "sans base URL, openai-compatible est indisponible");
    process.env.LLM_TAPE = `replay:${tapeFile("dispo")}`;
    assert.equal(llmAvailable(), true);
    assert.equal(llmUnavailableReason(), null);
  } finally {
    process.env.LLM_BASE_URL = saved;
  }
});
