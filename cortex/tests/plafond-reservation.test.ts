/**
 * PLAFOND DE DÉPENSE PAR RÉSERVATION (audit fuites B2, I5) : un job ou une aide
 * ne dépense jamais plus que la valeur des crédits débités (crédits × valeur
 * d'un crédit, 0,9 $ par défaut). Vérifié avant chaque tentative d'appel
 * payant : au-delà, SPEND_CAP (arrêt propre, le générateur livre ce qui est prêt).
 * Les aides gardent le modèle de leur site (Opus pour le drill) et sont bornées en taille de réponse.
 *
 * Seam : lib/llm complete(), fournisseur payant factice (serveur HTTP local).
 * Aucun appel réel au modèle.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-plafond-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp,
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "20",
  AI_BUDGET_MARGIN: "unlimited",
  DAILY_GEN_QUOTA: "unlimited",
  DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
  SPEND_CAP_USD: "unlimited",
  SPEND_CAP_PER_USER_USD: "unlimited",
  CREDITS_COST_JSON: JSON.stringify({ qcm: 4, assist: 0.3 }),
  LLM_PROVIDER: "openai-compatible",
  LLM_API_KEY: "test-key",
  LLM_MODEL_OPUS: "claude-opus-5-5",
  LLM_MODEL_SONNET: "claude-sonnet-5-5",
  LLM_ALLOW_OPUS: "1",
  LLM_MAX_RETRIES: "0",
};
Object.assign(process.env, ENV);
delete process.env.JOB_SPEND_CAP_USD_PER_CREDIT;
// Aucun import statique du store : il lirait CORTEX_DATA_DIR avant l'affectation ci-dessus (imports remontés).

let server: http.Server;
let hits = 0;
let seen: Array<{ model: string; max_tokens: number | undefined }> = [];
/** Requête dont le prompt contient HANG : retenue jusqu'à release() (appel en vol). */
const held: http.ServerResponse[] = [];
const reply = (res: http.ServerResponse, out = OUT_TOKENS) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 1000, completion_tokens: out } }));
};
/** Chaque appel coûte ≈ 1,5 $ (150 000 jetons de sortie au tarif Sonnet). */
const OUT_TOKENS = 150_000;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      hits++;
      const j = JSON.parse(body || "{}");
      seen.push({ model: j.model, max_tokens: j.max_tokens ?? j.max_completion_tokens });
      if (JSON.stringify(j.messages ?? "").includes("HANG")) { held.push(res); return; }
      reply(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
beforeEach(() => { hits = 0; seen = []; });
after(async () => {
  for (const r of held) r.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL", "JOB_SPEND_CAP_USD_PER_CREDIT"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const inMl = async <T,>(user: string, fn: () => Promise<T>) => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser(user, () => runWithCourse("ml", fn));
};
const isSpendCap = (e: Error & { code?: string }) => e.code === "SPEND_CAP" && /plafond/i.test(e.message);

test("B2 : un QCM à 4 crédits s'arrête net quand sa dépense atteint 4 × 0,9 $ (arrêt propre, code SPEND_CAP)", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { setCurrentJob, clearCurrentJob } = await import("../lib/billing/usage-context");
  const { complete } = await import("../lib/llm");
  const ref = "job:qcmer:ml:501";
  await inMl("qcmer", async () => {
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 400, ref, jobSlot: true })).ok, true);
    setCurrentJob(501, "qcm", ref);
    try {
      await complete({ prompt: "a", model: "sonnet" });     // 0 $ engagé
      await complete({ prompt: "b", model: "sonnet" });     // 1,5 $ < 3,6 $
      await complete({ prompt: "c", model: "sonnet" });     // 3 $ < 3,6 $ : un QCM réel à 2-2,9 $ finit
      await assert.rejects(complete({ prompt: "d", model: "sonnet" }), isSpendCap);  // 4,5 $ ≥ 3,6 $
    } finally {
      clearCurrentJob();
    }
  });
  assert.equal(hits, 3, "le quatrième appel ne part pas chez le fournisseur");
});

test("B2 : le plafond suit le prix payé (8 crédits → deux fois plus de calcul)", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { setCurrentJob, clearCurrentJob } = await import("../lib/billing/usage-context");
  const { complete } = await import("../lib/llm");
  const ref = "job:big:ml:502";
  await inMl("big", async () => {
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 800, ref, jobSlot: true })).ok, true);
    setCurrentJob(502, "qcm", ref);
    try {
      for (let i = 0; i < 5; i++) await complete({ prompt: `p${i}`, model: "sonnet" }); // jusqu'à 6 $ < 7,2 $
      await assert.rejects(complete({ prompt: "p5", model: "sonnet" }), isSpendCap);
    } finally {
      clearCurrentJob();
    }
  });
  assert.equal(hits, 5);
});

test("B2 : des appels parallèles du même job ne font pas tomber le plafond tant qu'ils sont en vol", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { setCurrentJob, clearCurrentJob } = await import("../lib/billing/usage-context");
  const { complete } = await import("../lib/llm");
  const ref = "job:para:ml:503";
  await inMl("para", async () => {
    assert.equal((await reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 400, ref, jobSlot: true })).ok, true);
    setCurrentJob(503, "qcm", ref);
    try {
      // En vol : estimé à 400 000 jetons de sortie (≈ 4 $), au-delà des 3,6 $ du plafond.
      const long = complete({ prompt: "HANG", model: "sonnet", maxTokens: 400_000 });
      while (held.length === 0) await new Promise((r) => setTimeout(r, 10));
      await complete({ prompt: "parallèle", model: "sonnet" });   // passe : l'appel en vol ne compte pas encore
      reply(held.shift()!, 1000);                                  // il se termine à 0,01 $
      await long;
      await complete({ prompt: "suite", model: "sonnet" });       // 1,5 + 0,01 $ < 3,6 $
      await complete({ prompt: "encore", model: "sonnet" });      // 3,01 $ < 3,6 $
      await assert.rejects(complete({ prompt: "de trop", model: "sonnet" }), isSpendCap);
    } finally {
      clearCurrentJob();
    }
  });
});

test("B2 : réservation sans débit (propriétaire, facturation coupée) : rien à borner, pas de plafond", async () => {
  const { runWithLlmAuthorization } = await import("../lib/llm/authorization");
  const { complete } = await import("../lib/llm");
  // Réservation sans ligne de débit : rien n'a été payé sur elle, il n'y a rien à borner ici.
  await inMl("nobody", () => runWithLlmAuthorization({ kind: "job", ref: "job:nobody:ml:1" }, async () => {
    for (let i = 0; i < 3; i++) await complete({ prompt: `n${i}`, model: "sonnet" });
  }));
  assert.equal(hits, 3);
});

test("I5 : une aide (0,3 crédit) : modèle de son site, réponse bornée, puis arrêt au plafond ; le remboursement est offert", async () => {
  const { assistCall } = await import("../lib/billing/reserve");
  const { complete } = await import("../lib/llm");
  const { authGet } = await import("../db/auth-store");
  await inMl("helper", async () => {
    await assert.rejects(assistCall("drill", async () => {
      await complete({ prompt: "x", model: "opus", maxTokens: 64_000 });
      return complete({ prompt: "y", model: "opus" });     // 3 $ ≥ 0,3 × 0,9 $
    }), isSpendCap);
  });
  assert.equal(hits, 1);
  assert.equal(seen[0].model, "claude-opus-5-5", "le drill rédige un corrigé : il part sur Opus (décision du 23/11)");
  // Borne dure des aides (lib/llm ASSIST_MAX_TOKENS_CAP) : le drill demande 10 000 jetons (réflexion comprise).
  assert.ok((seen[0].max_tokens ?? Infinity) <= 12_000, `réponse bornée (${seen[0].max_tokens})`);
  const refund = await authGet<{ delta: number; offered: number | null }>(
    `SELECT delta, offered FROM credit_transactions WHERE user_id = 'helper' AND ref LIKE 'refund:assist:%'`,
  );
  assert.equal(Number(refund?.delta), 30, "l'aide arrêtée est rendue");
  assert.equal(Number(refund?.offered), 1, "après dépense : en crédits offerts, pas en crédits achetés");
});
