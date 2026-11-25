process.env.CREDITS_COST_JSON = JSON.stringify({ exam: 6, qcm: 4, exercise: 1, "lab-exercise": 1, blueprint: 1, format: 1, prepare: 2, assist: 0.3 });

/**
 * Assistance (drill, check-solution) quand le modèle répond du texte illisible —
 * le « mcp.assist_failed code=unknown » de CS-290 (01/11) : le SyntaxError de
 * l'ancien extractJson n'avait pas de code. Verrouillé :
 *  - la réponse est redemandée avec l'erreur (3 essais), en sortie structurée ;
 *  - après 3 échecs : erreur BAD_OUTPUT au message clair, côté app ET connecteur,
 *    et l'appel est REMBOURSÉ (notre défaut, l'utilisateur n'a rien reçu) ;
 *  - une panne du fournisseur garde son message clair et son débit (décision du lot 2).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-assist-bad-"));
process.env.CORTEX_DATA_DIR = tmp;
// Budget IA lié au revenu (testé dans ai-budget.test.ts) : ici, les comptes sont financés par des crédits offerts.
process.env.AI_BUDGET_MARGIN = "unlimited";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "3";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
// Relecture de check_answer (lib/assist-review) testée dans aides-relecture.test.ts : ici, un seul appel par essai.
process.env.CORTEX_CHECK_REVIEW = "0";
// Aides de l'app en job : aucune place pour un worker détaché, le test exécute le job lui-même.
process.env.MAX_GLOBAL_ASSIST_JOBS = "0";

let reply: () => { status?: number; content?: string } = () => ({ content: "{}" });
let calls = 0;
const bodies: Record<string, unknown>[] = [];
let server: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls++;
      bodies.push(JSON.parse(body));
      const r = reply();
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(r.status ? "boom" : JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { calls = 0; bodies.length = 0; });

after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of ["MAX_GLOBAL_ASSIST_JOBS", "CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (route: string, body: unknown) =>
  new NextRequest(`http://cortex.test/api/${route}?course=cs-202`, {
    method: "POST", headers: { "content-type": "application/json", "accept-language": "fr" }, body: JSON.stringify(body),
  });

type JobJson = { status: string; error?: string | null; errorInfo?: { code: string } | null; drill?: { statement_html: string }; check?: { verdict: string } };

/** Aide de l'app (drill, correction) : la route lance le job, le worker l'exécute, la page lit /api/jobs/[id]. */
async function webJob(res: Response): Promise<JobJson> {
  assert.equal(res.status, 200, await res.clone().text());
  const { jobId } = (await res.json()) as { jobId: number };
  const { runWithCourse } = await import("../db/client");
  const { getJob } = await import("../lib/jobs");
  await runWithCourse("cs-202", async () => {
    const job = (await getJob(jobId))!;
    if (job.type === "drill") await (await import("../lib/drill-job")).executeDrillJob(jobId);
    else await (await import("../lib/check-job")).executeCheckJob(jobId);
  });
  const { GET } = await import("../app/api/jobs/[id]/route");
  const out = await GET(new NextRequest(`http://cortex.test/api/jobs/${jobId}?course=cs-202`, { headers: { "accept-language": "fr" } }), { params: Promise.resolve({ id: String(jobId) }) });
  return (await out.json()) as JobJson;
}

test("drill (app) : un énoncé avec bloc de code dans du ```json est lu, en sortie structurée", async () => {
  const { POST } = await import("../app/api/drill/route");
  const drill = { concept: "groupby", statement_html: "<p>Code :</p>\n```python\nprint(df.groupby(\"sex\").mean())\n```", hints: ["a", "b", "c", "d", "e"], solution_html: "<p>Moyenne par groupe.</p>" };
  reply = () => ({ content: "```json\n" + JSON.stringify(drill, null, 2) + "\n```" });
  const out = await webJob(await POST(post("drill", { concept: "groupby" })));
  assert.equal(out.drill?.statement_html, drill.statement_html);
  assert.equal(calls, 1);
  assert.ok(bodies[0].response_format, "le drill demande une sortie structurée");
});

test("drill (app) : 3 réponses illisibles → job en échec au message clair, appel remboursé", async () => {
  const { POST } = await import("../app/api/drill/route");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  reply = () => ({ content: "Voici une question d'entraînement sur groupby." });
  const out = await webJob(await POST(post("drill", { concept: "groupby" })));
  assert.equal(out.status, "error");
  assert.equal(out.errorInfo?.code, "llm_bad_output");
  assert.match(out.error ?? "", /illisible/);
  assert.equal(calls, 3, "redemandé avec l'erreur, 3 essais");
  assert.equal(await credits.getBalanceCenti("owner"), before, "notre défaut : rien ne reste débité");
});

test("check-solution (app) : réponse illisible → échec clair et remboursé ; réponse valide lue", async () => {
  const { POST } = await import("../app/api/check-solution/route");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  reply = () => ({ content: "Correct !" });
  const bad = await webJob(await POST(post("check-solution", { statement: "Que vaut 1+1 ?", answer: "2" })));
  assert.equal(bad.status, "error");
  assert.match(bad.error ?? "", /illisible/);
  assert.equal(await credits.getBalanceCenti("owner"), before);
  const verdict = { verdict: "correct", feedback: "Juste.", correct_solution: "2", criteria: [
    { label: "Calcule 1+1", points: 1, achieved: true, essential: true, justification: "2 est donné." },
    { label: "Donne le résultat", points: 1, achieved: true, essential: false, justification: "Résultat donné." },
  ] };
  reply = () => ({ content: "```json\n" + JSON.stringify(verdict) + "\n```" });
  const ok = await webJob(await POST(post("check-solution", { statement: "Que vaut 1+1 ?", answer: "2" })));
  assert.equal(ok.check?.verdict, "correct");
  assert.ok(bodies.at(-1)!.response_format, "la correction demande une sortie structurée");
});

test("check-solution (app) : deux réponses se corrigent en même temps ; la question corrigée est dans le job", async () => {
  const { POST } = await import("../app/api/check-solution/route");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  const first = await POST(post("check-solution", { statement: "Que vaut 1+1 ?", answer: "2", examId: 7, questionId: 3 }));
  assert.equal(first.status, 200);
  const { jobId } = (await first.clone().json()) as { jobId: number };
  // Comme avant le passage en job : vérifier une autre réponse pendant que la première se corrige.
  const second = await POST(post("check-solution", { statement: "Que vaut 2+2 ?", answer: "4", examId: 7, questionId: 4 }));
  assert.equal(second.status, 200);
  const { jobId: other } = (await second.clone().json()) as { jobId: number };
  assert.notEqual(other, jobId, "chaque réponse a sa correction");
  assert.equal(await credits.getBalanceCenti("owner"), before - 60, "chacune débitée une fois");
  const { runWithCourse } = await import("../db/client");
  const { getJob, listActiveJobs } = await import("../lib/jobs");
  await runWithCourse("cs-202", async () => {
    const job = (await getJob(jobId))!;
    assert.deepEqual(JSON.parse(job.target!).question, { examId: 7, questionId: 3 }, "la page retrouve la question au retour");
    assert.deepEqual((await listActiveJobs()).map((j) => j.id), [other, jobId], "suivies par la pastille");
  });
  reply = () => ({ content: JSON.stringify({ verdict: "correct", feedback: "Juste.", correct_solution: "2", criteria: [{ label: "Résultat", points: 1, achieved: true, essential: true, justification: "2." }] }) });
  assert.equal((await webJob(first)).check?.verdict, "correct");
  assert.equal((await webJob(second)).check?.verdict, "correct");
});

test("check-solution (app) : la photo de la réponse est lue par le worker, la cible ne porte que son nom", async () => {
  const { POST } = await import("../app/api/check-solution/route");
  const form = new FormData();
  form.append("statement", "Calcule ∫₀¹ x dx");
  form.append("image", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "copie.png", { type: "image/png" }));
  const encoded = new Response(form);
  const buf = Buffer.from(await encoded.arrayBuffer());
  const res = await POST(new NextRequest("http://cortex.test/api/check-solution?course=cs-202", {
    method: "POST", body: buf, headers: { "accept-language": "fr", "content-type": encoded.headers.get("content-type")!, "content-length": String(buf.length) },
  }));
  assert.equal(res.status, 200, await res.clone().text());
  const { jobId } = (await res.clone().json()) as { jobId: number };
  const { runWithCourse } = await import("../db/client");
  const { getJob } = await import("../lib/jobs");
  const target = JSON.parse((await runWithCourse("cs-202", () => getJob(jobId)))!.target!) as { image?: string };
  assert.match(target.image ?? "", /^[0-9a-f-]{36}\.png$/, "un nom de fichier, jamais un chemin du serveur");
  reply = () => ({ content: JSON.stringify({ verdict: "partial", feedback: "Presque.", correct_solution: "1/2", criteria: [{ label: "Primitive", points: 1, achieved: true, essential: true, justification: "x²/2." }] }) });
  const out = await webJob(res);
  assert.equal(out.check?.verdict, "partial");
  const prompt = JSON.stringify(bodies.at(-1));
  assert.match(prompt, new RegExp(`uploads/${target.image!.replace(".", "\\.")}`), "le worker passe la photo au modèle");
});

test("panne du fournisseur (app) : message clair, sans le texte brut du fournisseur", async () => {
  const { POST } = await import("../app/api/drill/route");
  reply = () => ({ status: 503 });
  const out = await webJob(await POST(post("drill", { concept: "groupby" })));
  assert.equal(out.status, "error");
  assert.equal(out.errorInfo?.code, "llm_provider_unreachable");
  assert.match(out.error ?? "", /surchargé ou injoignable/);
  assert.doesNotMatch(out.error ?? "", /boom|HTTP 503/);
});

test("connecteur MCP : chaque cause a son message et son code, jamais « unknown »", async () => {
  const { runAssist } = await import("../lib/mcp/assist");
  const { LlmError } = await import("../lib/llm");
  const { ToolError } = await import("../lib/mcp/tool");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  const cases: [Error, RegExp][] = [
    [new LlmError("Le modèle a renvoyé une réponse illisible 3 fois de suite (x).", "BAD_OUTPUT"), /unreadable[\s\S]*Nothing was charged/],
    [new LlmError("529 overloaded_error", "OVERLOADED", true), /overloaded or unreachable/],
    [new LlmError("Request timed out", "TIMEOUT", true), /too long to respond/],
  ];
  for (const [err, msg] of cases) {
    await assert.rejects(runAssist("drill", async () => { throw err; }), (e: unknown) => e instanceof ToolError && e.code === "unavailable" && e.reason === (err as InstanceType<typeof LlmError>).code && msg.test(e.message) && !/529|overloaded_error|timed out/.test(e.message));
  }
  // BAD_OUTPUT rendu, pannes du fournisseur débitées (lot 2) : 2 appels de 0,3 crédit restent dus.
  assert.equal(await credits.getBalanceCenti("owner"), before - 60);
});
