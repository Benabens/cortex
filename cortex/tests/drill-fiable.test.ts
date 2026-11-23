/**
 * DRILL FIABLE (21/11/2026) — un drill d'algorithmique (Dijkstra, Bellman-Ford) sortait coupé trois
 * fois de suite : la réflexion du modèle et un corrigé-roman dépassaient 6 000 jetons, et chaque
 * relance renvoyait la MÊME demande. Verrouillé :
 *  - le drill pose son budget (12 000 jetons, effort haut depuis Opus 5.5) et un format compact ;
 *  - une réponse coupée n'est relancée qu'UNE fois, avec une demande qui change (question plus
 *    petite, corrigé abrégé, 6 000 jetons, effort bas) ; coupée encore → erreur, remboursée ;
 *  - le drill du connecteur est un job : réservé avant (0,3 crédit), exécuté par le worker, rendu
 *    par son point de reprise ; un échec de notre fait est rendu, un doublon ne débite rien.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-drill-fiable-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory",
  AI_BUDGET_MARGIN: "unlimited", BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "3",
  DAILY_ASSIST_QUOTA: "unlimited", RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited",
  // Aucune place pour un worker détaché : le job drill reste en file et le test l'exécute lui-même.
  MAX_GLOBAL_ASSIST_JOBS: "0",
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0",
};
Object.assign(process.env, ENV);

const DRILL = {
  concept: "Bellman-Ford",
  statement_html: "<p>Graphe à 4 sommets, une arête de poids −2 : distances depuis s ?</p>",
  hints: ["Initialise.", "Relâche chaque arête.", "Répète n−1 fois.", "Regarde l'arête négative.", "Au 2e tour, d(c) passe de 5 à 3 par b."],
  solution_html: "<ol><li>d(s)=0.</li><li>Tour 1 : d(a)=1, d(b)=4.</li><li>Tour 2 : d(c)=3.</li><li>Pas de cycle négatif.</li></ol>",
};

type Reply = { content?: string; finish?: string; status?: number };
let replies: Reply[] = [];
let calls = 0;
const bodies: Array<{ max_tokens: number; messages: Array<{ role: string; content: string }> }> = [];
let server: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls++;
      bodies.push(JSON.parse(body));
      const r = replies.length > 1 ? replies.shift()! : (replies[0] ?? { content: "{}" });
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(r.status ? "boom" : JSON.stringify({
        choices: [{ message: { content: r.content ?? "" }, finish_reason: r.finish ?? "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { calls = 0; bodies.length = 0; replies = []; });

after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CUT: Reply = { content: '{"concept":"Bellman-Ford","statement_html":"<p>Graphe', finish: "length" };
const OK: Reply = { content: JSON.stringify(DRILL) };
const userPrompt = (i: number) => bodies[i].messages.find((m) => m.role === "user")!.content;
const post = (body: unknown) =>
  new NextRequest("http://cortex.test/api/drill?course=cs-202", {
    method: "POST", headers: { "content-type": "application/json", "accept-language": "fr" }, body: JSON.stringify(body),
  });
const balance = async () => (await import("../lib/billing/credits")).getBalanceCenti("owner");

test("drill : son budget et son format compact sont posés (12 000 jetons, indice 5 = étape décisive)", async () => {
  const { POST } = await import("../app/api/drill/route");
  replies = [OK];
  const res = await POST(post({ concept: "Bellman-Ford" }));
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal(bodies[0].max_tokens, 12_000, "le drill demande son budget, pas le défaut des aides (6 000)");
  assert.match(userPrompt(0), /étape décisive/);
  assert.match(userPrompt(0), /350 mots au plus/);
});

test("coupure : relancée UNE fois, avec une demande qui change (plus petite, corrigé abrégé), et livrée", async () => {
  const { POST } = await import("../app/api/drill/route");
  const before = await balance();
  replies = [CUT, OK];
  const res = await POST(post({ concept: "Bellman-Ford" }));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as { drill: typeof DRILL }).drill.hints[4], DRILL.hints[4]);
  assert.equal(calls, 2);
  assert.notEqual(userPrompt(1), userPrompt(0), "la relance ne renvoie pas la même demande");
  assert.match(userPrompt(1), /TROP LONGUE/);
  assert.ok(bodies[1].max_tokens < bodies[0].max_tokens, "la relance demande moins");
  assert.equal(await balance(), before - 30, "un drill livré coûte 0,3 crédit, relance comprise");
});

test("coupé deux fois : erreur claire après 2 appels (pas 3 fois la même chose), appel remboursé", async () => {
  const { POST } = await import("../app/api/drill/route");
  const before = await balance();
  replies = [CUT];
  const res = await POST(post({ concept: "Dijkstra" }));
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { code: string }).code, "llm_bad_output");
  assert.equal(calls, 2, "une seule relance, déjà changée");
  assert.equal(await balance(), before, "notre défaut : rien ne reste débité");
});

test("job drill (connecteur) : réservé, exécuté, lu par son point de reprise ; un doublon ne débite rien", async () => {
  const { runWithCourse } = await import("../db/client");
  const { startDrillJob, executeDrillJob, drillOfJob } = await import("../lib/drill-job");
  const { activeJob, getJob } = await import("../lib/jobs");
  const before = await balance();
  replies = [CUT, OK];
  await runWithCourse("cs-202", async () => {
    const first = await startDrillJob("Bellman-Ford");
    assert.equal(first.existing, false);
    assert.equal(await balance(), before - 30, "0,3 crédit réservé au lancement");
    assert.equal(calls, 0, "le modèle n'est appelé que par le worker");
    const again = await startDrillJob("Dijkstra");
    assert.deepEqual(again, { jobId: first.jobId, existing: true }, "un drill à la fois par cours");
    assert.equal(await balance(), before - 30, "le doublon ne débite rien");
    assert.equal(await activeJob(), null, "un drill n'occupe pas le bandeau des générations");

    assert.deepEqual(await executeDrillJob(first.jobId), { ok: true });
    const job = (await getJob(first.jobId))!;
    assert.equal(job.status, "done");
    assert.equal(calls, 2, "coupé puis relancé abrégé, dans le job aussi");
    assert.deepEqual(await drillOfJob(job), DRILL);
    // Une reprise (worker relancé après un déploiement) livre le point de reprise sans rappeler le modèle.
    assert.deepEqual(await executeDrillJob(first.jobId), { ok: true });
    assert.equal(calls, 2);
  });
  assert.equal(await balance(), before - 30);
});

test("job drill : réponse illisible → job en erreur, crédit rendu ; panne du fournisseur → débit gardé", async () => {
  const { runWithCourse } = await import("../db/client");
  const { startDrillJob, executeDrillJob, drillOfJob } = await import("../lib/drill-job");
  const { getJob } = await import("../lib/jobs");
  await runWithCourse("cs-202", async () => {
    const before = await balance();
    replies = [{ content: "Voici une question sur Dijkstra." }];
    const bad = await startDrillJob("Dijkstra");
    const r = await executeDrillJob(bad.jobId);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.info.creditsBackCenti, 30);
    const job = (await getJob(bad.jobId))!;
    assert.equal(job.status, "error");
    assert.equal(await drillOfJob(job), null);
    assert.equal(await balance(), before, "notre défaut : rendu");

    replies = [{ status: 503 }];
    const down = await startDrillJob("Dijkstra");
    const r2 = await executeDrillJob(down.jobId);
    assert.equal(r2.ok, false);
    assert.equal(!r2.ok && r2.info.creditsBackCenti, undefined);
    assert.equal(await balance(), before - 30, "panne du fournisseur : débitée, comme toutes les aides");
  });
});
