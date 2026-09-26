/**
 * B5 — l'assistance n'est plus gratuite : chaque appel (drill, correction,
 * analyses) RÉSERVE 0,1 crédit avant d'appeler le modèle, atomiquement. Un
 * compte à 0,25 crédit obtient deux appels, pas trois ; en parallèle, un solde
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
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0.25";
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
  assert.equal(await credits.getBalanceCenti("owner"), 25);
  assert.equal((await POST(post({}))).status, 400);
  assert.equal(await credits.getBalanceCenti("owner"), 25, "un corps invalide ne doit rien débiter");
  const base = process.env.LLM_BASE_URL;
  delete process.env.LLM_BASE_URL; // moteur indisponible
  try {
    assert.equal((await POST(post({ concept: "inode" }))).status, 503);
    assert.equal(await credits.getBalanceCenti("owner"), 25, "un moteur indisponible ne doit rien débiter");
  } finally { process.env.LLM_BASE_URL = base; }
});

test("drill : 0,25 crédit → deux appels débités (0,1 chacun), le troisième refusé en 402", async () => {
  const { POST } = await import("../app/api/drill/route");
  const credits = await import("../lib/billing/credits");
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await POST(post({ concept: "inode" }))).status);
  // Les deux premiers passent la réservation puis l'appel part et échoue (502) ;
  // le troisième est refusé AVANT tout appel.
  assert.deepEqual(statuses, [502, 502, 402]);
  assert.equal(await credits.getBalanceCenti("owner"), 5); // 25 - 10 - 10
});

test("assistGate : solde pour UN appel, 5 réservations parallèles → exactement 1", async () => {
  const { assistGate } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const { runWithUser } = await import("../db/context");
  await credits.addTransaction("usr_par", 10, "test", "test:usr_par:+10"); // signup 25 + 10 = 35 → on ramène à 10
  await credits.addTransaction("usr_par", -25, "test", "test:usr_par:-25");
  assert.equal(await credits.getBalanceCenti("usr_par"), 10);
  const results = await Promise.all(Array.from({ length: 5 }, () => runWithUser("usr_par", () => assistGate("drill"))));
  assert.equal(results.filter((r) => r === null).length, 1, JSON.stringify(results));
  assert.equal(await credits.getBalanceCenti("usr_par"), 0);
});

test("aucune route d'assistance ne garde l'ancien gate sans débit", () => {
  const routes = ["drill", "check-solution", "weaknesses/mine", "weaknesses/analyze", "weaknesses/process"];
  for (const r of routes) {
    const src = fs.readFileSync(path.join(__dirname, "..", "app", "api", r, "route.ts"), "utf8");
    assert.ok(/assist(?:Gate|Call)\(/.test(src), `${r} : pas de réservation d'assistance`);
    assert.ok(!src.includes('recordGeneration("assist"'), `${r} : ancien comptage sans débit encore présent`);
  }
});
