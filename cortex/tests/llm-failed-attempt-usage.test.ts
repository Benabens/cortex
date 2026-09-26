/**
 * I10 — un appel PAYANT qui échoue APRÈS envoi (timeout, coupure) a été
 * facturé par le fournisseur mais n'apparaissait pas dans llm_usage : le
 * plafond de dépense sous-estimait la réalité, et chaque tentative de retry
 * ajoutait une facture invisible. Chaque tentative échouée est désormais
 * comptée avec une ESTIMATION (tokens d'entrée ≈ taille du prompt, sortie =
 * max_tokens demandé), marquée estimated=1. Le prix d'un job suit sa taille.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fail-usage-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "nim-test-key";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5"; // tarif connu → coût > 0
process.env.LLM_MAX_RETRIES = "1";
process.env.LLM_RETRY_BASE_MS = "1";
process.env.CORTEX_TRACK_USAGE = "1";
delete process.env.SPEND_CAP_USD;

let server: http.Server;
/** Comportement du faux endpoint : « hang » ne répond jamais (le client expire), « ok » répond. */
let behaviour: (n: number) => "hang" | "ok" = () => "hang";
let received = 0;

before(async () => {
  server = http.createServer((req, res) => {
    received++;
    if (behaviour(received) === "hang") return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_RETRY_BASE_MS", "CORTEX_TRACK_USAGE", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("timeout après envoi, 1 retry → 2 tentatives estimées dans llm_usage (estimated=1, sortie = max_tokens)", async () => {
  const { complete } = await import("../lib/llm");
  const { authAll } = await import("../db/auth-store");
  const prompt = "x".repeat(4000); // ≈ 1000 tokens d'entrée
  behaviour = () => "hang";
  await assert.rejects(
    () => complete({ prompt, model: "opus", timeoutMs: 300, maxTokens: 512 }),
    (e: Error & { code?: string }) => e.code === "TIMEOUT",
  );
  const rows = await authAll<{ estimated: number; tokens_in: number; tokens_out: number; cost_usd: number; attempt: number }>(
    `SELECT estimated, tokens_in, tokens_out, cost_usd, attempt FROM llm_usage ORDER BY id`,
  );
  assert.equal(rows.length, 2, `lignes : ${JSON.stringify(rows)}`);
  for (const r of rows) {
    assert.equal(Number(r.estimated), 1);
    assert.equal(Number(r.tokens_out), 512);
    assert.ok(Number(r.tokens_in) >= 900 && Number(r.tokens_in) <= 1100, `tokens_in ${r.tokens_in}`);
    assert.ok(Number(r.cost_usd) > 0);
  }
  assert.deepEqual(rows.map((r) => Number(r.attempt)), [0, 1]);
});

test("succès après un timeout : la tentative perdue est estimée, la réussie est réelle", async () => {
  const { complete } = await import("../lib/llm");
  const { authAll } = await import("../db/auth-store");
  // La première requête REÇUE est pendue ; les suivantes répondent. Deux retries
  // pour absorber une tentative expirée avant même d'atteindre le serveur (machine chargée).
  const first = received;
  behaviour = (n) => (n === first + 1 ? "hang" : "ok");
  process.env.LLM_MAX_RETRIES = "2";
  const res = await complete({ prompt: "bonjour", model: "opus", timeoutMs: 300, maxTokens: 64 });
  process.env.LLM_MAX_RETRIES = "1";
  assert.equal(res.text, "ok");
  const rows = await authAll<{ estimated: number; tokens_out: number }>(`SELECT estimated, tokens_out FROM llm_usage ORDER BY id`);
  const after = rows.slice(2);
  assert.ok(after.length >= 2, `lignes : ${JSON.stringify(after)}`);
  const last = after[after.length - 1];
  assert.deepEqual([Number(last.estimated), Number(last.tokens_out)], [0, 3], "la tentative réussie est réelle");
  for (const r of after.slice(0, -1)) assert.deepEqual([Number(r.estimated), Number(r.tokens_out)], [1, 64], "les tentatives perdues sont estimées");
});

test("prix proportionnel à la taille : mock standard = 1 unité, 8 exercices inclus", async () => {
  const { costForJob } = await import("../lib/jobs");
  assert.equal(costForJob("qcm", undefined), 100);
  assert.equal(costForJob("qcm", JSON.stringify({ count: 20, openCount: 3 })), 100); // le mock standard
  assert.equal(costForJob("qcm", JSON.stringify({ count: 40, openCount: 0 })), 200);
  assert.equal(costForJob("qcm", JSON.stringify({ count: 40, openCount: 3 })), 200);
  assert.equal(costForJob("qcm", JSON.stringify({ count: 2, openCount: 0 })), 100); // drill : jamais moins que la base
  assert.equal(costForJob("exam", undefined), 200);
  assert.equal(costForJob("exam", JSON.stringify({ count: 8 })), 200);
  assert.equal(costForJob("exam", JSON.stringify({ count: 12 })), 300);
  assert.equal(costForJob("exercise", "pipelines"), 100);
});
