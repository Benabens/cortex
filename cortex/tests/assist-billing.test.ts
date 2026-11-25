process.env.CREDITS_COST_JSON = JSON.stringify({ exam: 6, qcm: 4, exercise: 1, "lab-exercise": 1, blueprint: 1, format: 1, prepare: 2, assist: 0.3 });

/**
 * B5 — l'assistance n'est plus gratuite : chaque appel (drill, correction,
 * analyses) RÉSERVE 0,3 crédit avant d'appeler le modèle, atomiquement. Un
 * compte à 0,65 crédit obtient deux appels, pas trois ; en parallèle, un solde
 * pour un seul appel n'en laisse passer qu'un.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-assist-"));
process.env.CORTEX_DATA_DIR = tmp;
// Budget IA lié au revenu (testé dans ai-budget.test.ts) : ici, les comptes sont financés par des crédits offerts.
process.env.AI_BUDGET_MARGIN = "unlimited";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0.65";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
// Provider API pointé sur un faux endpoint local qui répond 500 : l'appel PART
// (donc la réservation est due), échoue, et rien ne sort sur le réseau.
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
let server: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((_req, res) => { res.statusCode = 500; res.end("boom"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (body: unknown) =>
  new NextRequest("http://cortex.test/api/drill?course=cs-202", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

test("drill : requête invalide → 400 SANS débit ; moteur indisponible → 503 SANS débit", async () => {
  const { POST } = await import("../app/api/drill/route");
  const credits = await import("../lib/billing/credits");
  assert.equal(await credits.getBalanceCenti("owner"), 65);
  assert.equal((await POST(post({}))).status, 400);
  assert.equal(await credits.getBalanceCenti("owner"), 65, "un corps invalide ne doit rien débiter");
  const base = process.env.LLM_BASE_URL;
  delete process.env.LLM_BASE_URL; // moteur indisponible
  try {
    assert.equal((await POST(post({ concept: "inode" }))).status, 503);
    assert.equal(await credits.getBalanceCenti("owner"), 65, "un moteur indisponible ne doit rien débiter");
  } finally { process.env.LLM_BASE_URL = base; }
});

test("drill : 0,65 crédit → deux appels débités (0,3 chacun), le troisième refusé en 402", async () => {
  const { POST } = await import("../app/api/drill/route");
  const credits = await import("../lib/billing/credits");
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await POST(post({ concept: "inode" }))).status);
  // Les deux premiers réservent leur 0,3 et lancent leur job (le modèle est appelé par le worker,
  // 24/11/2026) ; le troisième est refusé AVANT tout job.
  assert.deepEqual(statuses, [200, 200, 402]);
  assert.equal(await credits.getBalanceCenti("owner"), 5); // 65 - 30 - 30
});

test("assistGate : solde pour UN appel, 5 réservations parallèles → exactement 1", async () => {
  const { assistGate } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const { runWithUser } = await import("../db/context");
  await credits.addTransaction("usr_par", 30, "test", "test:usr_par:+30"); // signup 65 + 30 = 95 → on ramène à 30
  await credits.addTransaction("usr_par", -65, "test", "test:usr_par:-65");
  assert.equal(await credits.getBalanceCenti("usr_par"), 30);
  const results = await Promise.all(Array.from({ length: 5 }, () => runWithUser("usr_par", () => assistGate("drill"))));
  assert.equal(results.filter((r) => r === null).length, 1, JSON.stringify(results));
  assert.equal(await credits.getBalanceCenti("usr_par"), 0);
});

test("aucune route d'assistance ne garde l'ancien gate sans débit", () => {
  const routes = ["drill", "check-solution", "weaknesses/mine", "weaknesses/analyze", "weaknesses/process"];
  // Exercice ciblé et correction : la route lance un job, qui réserve au lancement (lib/drill-job, lib/check-job).
  const jobs: Record<string, string> = { drill: "drill-job.ts", "check-solution": "check-job.ts" };
  for (const r of routes) {
    const src = fs.readFileSync(path.join(__dirname, "..", "app", "api", r, "route.ts"), "utf8");
    const job = jobs[r] ? fs.readFileSync(path.join(__dirname, "..", "lib", jobs[r]), "utf8") : "";
    assert.ok(/assist(?:Gate|Call)\(/.test(src) || (/start(?:Drill|Check)Job\(/.test(src) && /assistReserve\(/.test(job)), `${r} : pas de réservation d'assistance`);
    assert.ok(!src.includes('recordGeneration("assist"'), `${r} : ancien comptage sans débit encore présent`);
  }
});
