/**
 * Un appel payant est compté DÈS SON DÉPART (ligne estimée), puis finalisé
 * avec les compteurs réels au retour. Ainsi un worker tué en plein appel
 * (annulation, crash) laisse une trace de coût : le remboursement conditionné
 * au coût réel ne peut pas être détourné en annulant pendant le premier appel,
 * et le plafond de dépense voit les appels en vol.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-inflight-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "nim-test-key";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.CORTEX_TRACK_USAGE = "1";
delete process.env.SPEND_CAP_USD;

let server: http.Server;
let mode: "hang" | "ok" | "error" | "cut" = "ok";
const pending: http.ServerResponse[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    if (mode === "hang") { pending.push(res); return; }
    if (mode === "error") { res.statusCode = 500; res.end("boom"); return; }
    if (mode === "cut") {
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.flushHeaders();
      res.write("{\"choices\":[");
      setTimeout(() => res.destroy(), 30); // le fournisseur a commencé à répondre puis coupe
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  for (const r of pending) r.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "CORTEX_TRACK_USAGE", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Row = { estimated: number; tokens_in: number | null; tokens_out: number | null; cost_usd: number };
const rows = async () => (await import("../db/auth-store")).authAll<Row>(`SELECT estimated, tokens_in, tokens_out, cost_usd FROM llm_usage ORDER BY id`);

test("pendant l'appel : une ligne estimée existe déjà ; au retour : finalisée en place (pas de doublon)", async () => {
  const { complete } = await import("../lib/llm");
  mode = "hang";
  const p = complete({ prompt: "y".repeat(400), model: "opus", timeoutMs: 5_000, maxTokens: 256 });
  await new Promise((r) => setTimeout(r, 200)); // l'appel est en vol
  const during = await rows();
  assert.equal(during.length, 1, "l'appel en vol doit déjà être compté");
  assert.equal(Number(during[0].estimated), 1);
  assert.equal(Number(during[0].tokens_out), 256);
  assert.ok(Number(during[0].cost_usd) > 0);
  // Le serveur répond maintenant.
  mode = "ok";
  const res = pending.shift()!;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
  assert.equal((await p).text, "ok");
  const afterRows = await rows();
  assert.equal(afterRows.length, 1, "finalisation en place, pas une seconde ligne");
  assert.deepEqual([Number(afterRows[0].estimated), Number(afterRows[0].tokens_in), Number(afterRows[0].tokens_out)], [0, 11, 3]);
});

test("refus avant traitement (HTTP 500) : la ligne provisoire est retirée — rien n'a été facturé", async () => {
  const { complete } = await import("../lib/llm");
  mode = "error";
  await assert.rejects(() => complete({ prompt: "z", model: "opus", timeoutMs: 5_000 }));
  assert.equal((await rows()).length, 1, "aucune ligne ajoutée pour un 5xx");
});

test("timeout : la ligne provisoire reste (le fournisseur a facturé)", async () => {
  const { complete } = await import("../lib/llm");
  mode = "hang";
  await assert.rejects(() => complete({ prompt: "w", model: "opus", timeoutMs: 200, maxTokens: 32 }), (e: Error & { code?: string }) => e.code === "TIMEOUT");
  const all = await rows();
  assert.equal(all.length, 2);
  assert.deepEqual([Number(all[1].estimated), Number(all[1].tokens_out)], [1, 32]);
});

test("coupure APRÈS envoi (réponse tronquée) : la ligne reste — le fournisseur a très probablement facturé", async () => {
  const { complete } = await import("../lib/llm");
  mode = "cut";
  await assert.rejects(() => complete({ prompt: "v", model: "opus", timeoutMs: 5_000, maxTokens: 48 }));
  const all = await rows();
  assert.equal(all.length, 3, JSON.stringify(all));
  assert.deepEqual([Number(all[2].estimated), Number(all[2].tokens_out)], [1, 48]);
});
