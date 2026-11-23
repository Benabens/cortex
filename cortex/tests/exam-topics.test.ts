/**
 * OUTIL GRATUIT « What's on my exam? » (lib/exam-topics) : sans compte, donc chaque analyse
 * coûte à Cortex. Règles de Ben : quota par IP et par jour, plafond de dépense quotidien dédié
 * (FREE_TOOL_DAILY_USD), refus propre quand il est atteint, annales supprimées après l'analyse,
 * page partageable sans le texte des annales.
 *
 * Seams : admitRun (admission), complete() sous runExamTopicCall (plafonds au point d'entrée
 * LLM), analyzeExams (pipeline + nettoyage), routes /api/exam-topics. Store PGlite en mémoire,
 * faux fournisseur openai-compatible local : rien ne sort sur le réseau.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-topics-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp,
  EXAM_TOPICS_TMP_DIR: path.join(tmp, "uploads"),
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  TRUST_PROXY: "1",
  FREE_TOOL_ENABLED: "1",
  FREE_TOOL_DAILY_USD: "1",
  FREE_TOOL_RUN_USD: "0.3",
  FREE_TOOL_PER_IP_DAY: "2",
  FREE_TOOL_MAX_CONCURRENT: "5",
  LLM_PROVIDER: "openai-compatible",
  LLM_API_KEY: "test",
  LLM_MODEL_HAIKU: "claude-haiku-4-5-20251001",
  LLM_MAX_RETRIES: "0",
};
Object.assign(process.env, ENV);

/** Réponses du faux fournisseur, dans l'ordre ; `usage` facturé à chaque réponse. */
let replies: string[] = [];
let usage = { prompt_tokens: 10_000, completion_tokens: 2_000 };
let prompts: string[] = [];
/** Réponse selon le prompt (appels parallèles) ; prioritaire sur `replies`. */
let responder: ((prompt: string) => string) | null = null;
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      prompts.push(JSON.stringify(parsed.messages ?? []));
      const content = responder ? responder(prompts[prompts.length - 1]) : replies.shift() ?? "{}";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres?.();
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  replies = [];
  prompts = [];
  responder = null;
  usage = { prompt_tokens: 10_000, completion_tokens: 2_000 };
  const { authRun } = await import("../db/auth-store");
  await authRun(`DELETE FROM exam_topic_runs`);
  await authRun(`DELETE FROM llm_usage`);
  const { resetSpendCache } = await import("../lib/billing/usage");
  resetSpendCache();
});

const NOW = Date.parse("2026-11-22T12:00:00Z");

test("admission : quota par IP et par jour, puis refus « ip_day » ; une autre IP passe", async () => {
  const { admitRun } = await import("../lib/exam-topics/runs");
  const a = await admitRun({ ip: "198.51.100.7", now: NOW });
  const b = await admitRun({ ip: "198.51.100.7", now: NOW + 1000 });
  const c = await admitRun({ ip: "198.51.100.7", now: NOW + 2000 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(c, { ok: false, reason: "ip_day" });
  assert.equal((await admitRun({ ip: "203.0.113.9", now: NOW + 3000 })).ok, true, "autre IP");
  // 24 h plus tard, la même IP repasse.
  assert.equal((await admitRun({ ip: "198.51.100.7", now: NOW + 24 * 3600_000 + 5000 })).ok, true);
});

/** Dépense déjà faite aujourd'hui par l'outil (comme lib/llm l'écrit). */
async function spend(usd: number, user = "free-tool") {
  const { authRun } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  await authRun(
    `INSERT INTO llm_usage (user_id, course, provider, model, cost_usd, estimated, created_at) VALUES (?, 'x', 'anthropic', 'claude-haiku-4-5', ?, 0, ?)`,
    user, usd, nowStr(),
  );
  const { resetSpendCache } = await import("../lib/billing/usage");
  resetSpendCache();
}

test("admission : le plafond du jour doit couvrir une analyse entière ; 0 ferme l'outil ; la dépense des comptes ne compte pas", async () => {
  const { admitRun } = await import("../lib/exam-topics/runs");
  await spend(0.5, "un-etudiant");
  assert.equal((await admitRun({ ip: "198.51.100.1" })).ok, true, "la dépense d'un compte n'entame pas le plafond de l'outil");
  await spend(0.6); // reste 0,4 $ ≥ 0,3 $ d'une analyse
  assert.equal((await admitRun({ ip: "198.51.100.2" })).ok, true);
  await spend(0.15); // reste 0,25 $ < 0,3 $
  assert.deepEqual(await admitRun({ ip: "198.51.100.3" }), { ok: false, reason: "daily_budget" });
  process.env.FREE_TOOL_DAILY_USD = "0";
  try {
    assert.deepEqual(await admitRun({ ip: "198.51.100.4" }), { ok: false, reason: "closed" });
  } finally { process.env.FREE_TOOL_DAILY_USD = ENV.FREE_TOOL_DAILY_USD; }
  // « unlimited » (ou une faute de frappe) ne lève jamais le plafond : il vaut son défaut, 3 $.
  await spend(2.2); // 2,95 $ dépensés aujourd'hui par l'outil
  process.env.FREE_TOOL_DAILY_USD = "unlimited";
  try {
    assert.deepEqual(await admitRun({ ip: "198.51.100.5" }), { ok: false, reason: "daily_budget" });
  } finally { process.env.FREE_TOOL_DAILY_USD = ENV.FREE_TOOL_DAILY_USD; }
});

test("admission : au-delà des analyses simultanées, « busy » ; une analyse morte (> 10 min) ne bloque plus", async () => {
  const { admitRun } = await import("../lib/exam-topics/runs");
  process.env.FREE_TOOL_MAX_CONCURRENT = "1";
  try {
    assert.equal((await admitRun({ ip: "198.51.100.10", now: NOW })).ok, true);
    assert.deepEqual(await admitRun({ ip: "198.51.100.11", now: NOW + 1000 }), { ok: false, reason: "busy" });
    assert.equal((await admitRun({ ip: "198.51.100.11", now: NOW + 11 * 60_000 })).ok, true);
  } finally { process.env.FREE_TOOL_MAX_CONCURRENT = ENV.FREE_TOOL_MAX_CONCURRENT; }
});

test("point d'entrée LLM : un appel de l'outil exige une analyse admise et en cours, sous le pseudo-compte de l'outil", async () => {
  const { admitRun, failRun } = await import("../lib/exam-topics/runs");
  const { runExamTopicCall } = await import("../lib/exam-topics/llm");
  const { complete } = await import("../lib/llm");
  const { currentUser } = await import("../db/context");
  const run = await admitRun({ ip: "198.51.100.20" });
  assert.ok(run.ok);
  replies = ["ok"];
  const r = await runExamTopicCall(run.id, async () => ({ user: currentUser(), res: await complete({ prompt: "x", model: "haiku" }) }));
  assert.equal(r.user, "free-tool");
  assert.equal(r.res.text, "ok");
  const { authGet } = await import("../db/auth-store");
  const row = await authGet<{ user_id: string; credit_ref: string; cost_usd: number }>(`SELECT user_id, credit_ref, cost_usd FROM llm_usage ORDER BY id DESC LIMIT 1`);
  assert.equal(row?.user_id, "free-tool");
  assert.equal(row?.credit_ref, `exam-topics:${run.id}`);
  assert.ok(Math.abs(Number(row?.cost_usd) - 0.02) < 1e-9, "10 k entrée + 2 k sortie au tarif haiku = 0,02 $");

  await failRun(run.id, "test");
  replies = ["jamais"];
  await assert.rejects(runExamTopicCall(run.id, () => complete({ prompt: "x", model: "haiku" })), (e: Error & { code?: string }) => e.code === "PAYMENT_REQUIRED");
  await assert.rejects(runExamTopicCall("inconnu-inconnu-inconn", () => complete({ prompt: "x", model: "haiku" })), (e: Error & { code?: string }) => e.code === "PAYMENT_REQUIRED");
  assert.equal(replies.length, 1, "aucun appel n'est parti");
});

test("point d'entrée LLM : plafond d'UNE analyse puis plafond du jour de l'outil → SPEND_CAP, l'appel ne part pas", async () => {
  const { admitRun } = await import("../lib/exam-topics/runs");
  const { runExamTopicCall } = await import("../lib/exam-topics/llm");
  const { complete } = await import("../lib/llm");
  const run = await admitRun({ ip: "198.51.100.21" });
  assert.ok(run.ok);
  usage = { prompt_tokens: 100_000, completion_tokens: 20_000 }; // 0,2 $ par appel
  replies = ["a", "b", "c"];
  await runExamTopicCall(run.id, () => complete({ prompt: "x", model: "haiku" }));
  await runExamTopicCall(run.id, () => complete({ prompt: "x", model: "haiku" })); // 0,2 < 0,3 : part
  await assert.rejects(runExamTopicCall(run.id, () => complete({ prompt: "x", model: "haiku" })), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
  assert.deepEqual(replies, ["c"], "le troisième appel n'est pas parti");

  // Plafond du jour (1 $) : la dépense d'autres analyses du jour le remplit, l'analyse suivante est coupée net.
  const next = await admitRun({ ip: "198.51.100.22" });
  assert.ok(next.ok);
  await spend(0.7); // 0,4 + 0,7 = 1,1 $ ≥ 1 $
  await assert.rejects(runExamTopicCall(next.id, () => complete({ prompt: "x", model: "haiku" })), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
  assert.deepEqual(replies, ["c"]);
});

/** PDF minimal, une ligne de texte par page (une chaîne vide = page sans texte, comme un scan). */
function pdfOf(pages: string[]): Buffer {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const line of pages) {
    const stream = line ? `BT /F1 12 Tf 72 720 Td (${line}) Tj ET` : "";
    const pageNo = objs.length + 1;
    kids.push(`${pageNo} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${pageNo + 2} 0 R >> >> /Contents ${pageNo + 1} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const EXAM_A = pdfOf(["Problem 1 (10 pts) Run Dijkstra from s on the graph below", "Problem 2 (10 pts) Prove Dijkstra is correct", "Problem 3 (20 pts) Fill the knapsack table"]);
const EXAM_B = pdfOf(["Q1 (5 pts) Dijkstra trace from vertex a on the graph G", "Q2 (5 pts) Solve the recurrence T(n) = 2T(n/2) + n"]);
const exo = (topic: string, exo_type: string, points: number, example: string) => ({ page: 1, topic, method: "", exo_type, trap: "", example, points });

/** Faux modèle : extraction par annale (reconnue à son texte), puis regroupement. */
function examModel(prompt: string): string {
  if (prompt.includes("Run Dijkstra from s")) return JSON.stringify({ course_subject: "Algorithms", exercises: [
    exo("Dijkstra shortest path", "trace the algorithm", 10, "Run Dijkstra on a small weighted graph, see https://evil.example.com/x"),
    exo("Dijkstra's algorithm", "prove correctness", 10, "Prove the greedy choice is safe."),
    exo("Knapsack DP", "fill the DP table", 20, "Fill a 0/1 knapsack table."),
  ] });
  if (prompt.includes("Dijkstra trace")) return JSON.stringify({ course_subject: "Algorithms", exercises: [
    exo("Dijkstra", "trace the algorithm", 5, "Trace Dijkstra."),
    exo("Master theorem", "solve a recurrence", 5, "Solve a divide-and-conquer recurrence."),
  ] });
  if (prompt.includes("members")) return JSON.stringify({ types: [
    { label: "Shortest paths — Dijkstra", members: ["Dijkstra shortest path", "Dijkstra's algorithm", "Dijkstra"] },
    { label: "Dynamic programming — knapsack", members: ["Knapsack DP"] },
  ] });
  return "{}";
}

async function stage(id: string, files: Record<string, Buffer>): Promise<string> {
  const dir = path.join(ENV.EXAM_TOPICS_TMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  return dir;
}

test("analyse : sujets regroupés et pondérés sur les annales, exemple sans lien, dossier des annales supprimé", async () => {
  const { admitRun, getRun } = await import("../lib/exam-topics/runs");
  const { processRun } = await import("../lib/exam-topics/analyze");
  const run = await admitRun({ ip: "198.51.100.30" });
  assert.ok(run.ok);
  const dir = await stage(run.id, { "0.pdf": EXAM_A, "1.pdf": EXAM_B });
  responder = examModel;
  await processRun(run.id, dir, "en");

  assert.equal(fs.existsSync(dir), false, "les annales sont supprimées après l'analyse");
  assert.ok(prompts.some((p) => p.includes("Run Dijkstra from s")), "le texte du PDF est passé au modèle");
  const view = await getRun(run.id);
  assert.equal(view?.status, "done");
  if (view?.status !== "done") return;
  const r = view.result;
  assert.equal(r.subject, "Algorithms");
  assert.equal(r.papers, 2);
  assert.equal(r.questions, 5);
  const [top, ...rest] = r.topics;
  assert.equal(top.label, "Shortest paths: Dijkstra", "séparateur en tiret long rendu en deux-points");
  assert.equal(top.occurrences, 3);
  assert.equal(top.papers, 2);
  assert.equal(top.sharePct, 60);
  assert.equal(top.pointsPct, 50, "moyenne par annale : 20/40 et 5/10");
  assert.deepEqual(top.forms, ["trace the algorithm", "prove correctness"]);
  assert.ok(top.example && !/https?:|evil\.example/.test(top.example), "aucun lien publié depuis une annale");
  assert.deepEqual(rest.map((t) => [t.label, t.occurrences, t.sharePct, t.pointsPct]).sort(), [
    ["Dynamic programming: knapsack", 1, 20, 25],
    ["Master theorem", 1, 20, 25],
  ]);
  // Le résultat public ne porte que l'analyse : jamais le texte de l'annale.
  assert.equal(JSON.stringify(r).includes("Problem 1"), false);
});

test("analyse : rien d'exploitable → échec « no_questions », dossier supprimé quand même", async () => {
  const { admitRun, getRun } = await import("../lib/exam-topics/runs");
  const { processRun } = await import("../lib/exam-topics/analyze");
  const run = await admitRun({ ip: "198.51.100.31" });
  assert.ok(run.ok);
  const dir = await stage(run.id, { "0.pdf": EXAM_B });
  responder = () => "pas du JSON";
  await processRun(run.id, dir, "fr");
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(await getRun(run.id), { status: "failed", error: "no_questions" });
});

test("analyse : un plafond atteint en route → échec « budget », aucun résultat partiel publié", async () => {
  const { admitRun, getRun } = await import("../lib/exam-topics/runs");
  const { processRun } = await import("../lib/exam-topics/analyze");
  const run = await admitRun({ ip: "198.51.100.32" });
  assert.ok(run.ok);
  const dir = await stage(run.id, { "0.pdf": EXAM_A, "1.pdf": EXAM_B });
  responder = examModel;
  await spend(1); // plafond du jour (1 $) atteint après l'admission, avant le premier appel
  await processRun(run.id, dir, "en");
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(await getRun(run.id), { status: "failed", error: "budget" });
});

test("balayage : un dossier d'annales oublié (crash) est supprimé après 30 min, un dossier en cours est gardé", async () => {
  const { sweepStaleUploads } = await import("../lib/exam-topics/analyze");
  const old = await stage("ancien-ancien-ancien-a", { "0.pdf": EXAM_B });
  const fresh = await stage("recent-recent-recent-r", { "0.pdf": EXAM_B });
  const past = new Date(Date.now() - 31 * 60_000);
  fs.utimesSync(old, past, past);
  await sweepStaleUploads();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(fresh, { recursive: true, force: true });
});

test("analyse : une annale scannée (sans texte) part en images, dans la limite de pages", async (t) => {
  const { findPdftoppm } = await import("../lib/pdftoppm");
  if (!findPdftoppm()) return t.skip("pdftoppm absent");
  const { admitRun, getRun } = await import("../lib/exam-topics/runs");
  const { processRun } = await import("../lib/exam-topics/analyze");
  const run = await admitRun({ ip: "198.51.100.33" });
  assert.ok(run.ok);
  const dir = await stage(run.id, { "0.pdf": pdfOf(["", "", ""]) });
  responder = (p) => p.includes("data:image/png;base64")
    ? JSON.stringify({ course_subject: "Physics", exercises: [exo("Kinematics", "numerical problem", 0, "Compute a speed.")] })
    : "{}";
  await processRun(run.id, dir, "en");
  const view = await getRun(run.id);
  assert.equal(view?.status, "done");
  assert.equal((prompts[0].match(/data:image\/png;base64/g) ?? []).length, 3);
  assert.equal(fs.existsSync(dir), false);
});

test("analyse : PDF sans texte ni image possible → « unreadable », aucun appel", async () => {
  const { admitRun, getRun } = await import("../lib/exam-topics/runs");
  const { processRun } = await import("../lib/exam-topics/analyze");
  const run = await admitRun({ ip: "198.51.100.34" });
  assert.ok(run.ok);
  const dir = await stage(run.id, { "0.pdf": Buffer.from("%PDF-1.4 tronqué") });
  await processRun(run.id, dir, "en");
  assert.deepEqual(await getRun(run.id), { status: "failed", error: "unreadable" });
  assert.equal(prompts.length, 0);
});

async function post(fields: Record<string, string>, files: Buffer[], ip = "203.0.113.50") {
  const { POST } = await import("../app/api/exam-topics/route");
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  files.forEach((f, i) => form.append("files", new Blob([new Uint8Array(f)], { type: "application/pdf" }), `exam-${i}.pdf`));
  const draft = new Request("http://localhost/api/exam-topics", { method: "POST", body: form });
  const body = await draft.arrayBuffer();
  const req = new Request("http://localhost/api/exam-topics", {
    method: "POST", body,
    headers: { "content-type": draft.headers.get("content-type")!, "content-length": String(body.byteLength), "x-forwarded-for": ip },
  });
  const res = await POST(req);
  const json = await res.json() as { id?: string; code?: string };
  return { status: res.status, body: json.id ? { id: json.id } : { code: json.code } };
}

async function waitDone(id: string) {
  const { GET } = await import("../app/api/exam-topics/[id]/route");
  for (let i = 0; i < 100; i++) {
    const res = await GET(new Request(`http://localhost/api/exam-topics/${id}`), { params: Promise.resolve({ id }) });
    const view = await res.json() as { status: string };
    if (view.status !== "running") return view;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("analyse jamais finie");
}

test("route : fichier refusé ou robot → aucun quota consommé ; dépôt valide → 202, résultat lisible au lien ; 3e dépôt du jour → 429", async () => {
  responder = examModel;
  assert.deepEqual(await post({ website: "http://spam.example" }, [EXAM_A]), { status: 400, body: { code: "exam_topics_invalid" } });
  assert.deepEqual(await post({}, [Buffer.from("MZ pas un pdf")]), { status: 400, body: { code: "exam_topics_not_pdf" } });
  assert.deepEqual(await post({}, [EXAM_A, EXAM_A, EXAM_A, EXAM_A]), { status: 400, body: { code: "exam_topics_too_many_files" } });
  assert.deepEqual(await post({}, [pdfOf(Array.from({ length: 41 }, (_, i) => `Page ${i} with enough text to count as a real page`))]), { status: 400, body: { code: "exam_topics_too_many_pages" } });

  const a = await post({ lang: "en" }, [EXAM_A, EXAM_B]);
  assert.equal(a.status, 202);
  const view = await waitDone(a.body.id!) as { status: string; result?: { topics: { label: string }[] } };
  assert.equal(view.status, "done");
  assert.equal(view.result?.topics[0].label, "Shortest paths: Dijkstra");
  assert.equal((await post({}, [EXAM_B])).status, 202);
  assert.deepEqual(await post({}, [EXAM_B]), { status: 429, body: { code: "exam_topics_ip_day" } });
  await new Promise((r) => setTimeout(r, 200)); // laisse finir l'analyse en arrière-plan
});

test("route : lien inconnu ou mal formé → 404", async () => {
  const { GET } = await import("../app/api/exam-topics/[id]/route");
  for (const id of ["AAAAAAAAAAAAAAAAAAAAAA", "../../etc/passwd"]) {
    const res = await GET(new Request(`http://localhost/api/exam-topics/x`), { params: Promise.resolve({ id }) });
    assert.equal(res.status, 404);
  }
});

test("interrupteur : FREE_TOOL_ENABLED absent → outil fermé, 404 sur la route de dépôt et de lecture, aucun appel IA", async () => {
  delete process.env.FREE_TOOL_ENABLED;
  try {
    responder = examModel;
    const a = await post({ lang: "en" }, [EXAM_A, EXAM_B], "203.0.113.60");
    assert.deepEqual(a, { status: 404, body: { code: "exam_topics_not_found" } });
    assert.equal(prompts.length, 0, "aucun appel au modèle");

    const { GET } = await import("../app/api/exam-topics/[id]/route");
    const res = await GET(new Request("http://localhost/api/exam-topics/abc"), { params: Promise.resolve({ id: "abc" }) });
    assert.equal(res.status, 404);
  } finally {
    process.env.FREE_TOOL_ENABLED = "1";
  }
});

test("langue de l'outil : ?lang l'emporte et se retient, sinon le cookie, sinon l'anglais (jamais Accept-Language)", async () => {
  const { isToolPath, toolLocale, withLocaleCookie } = await import("../lib/exam-topics/locale");
  assert.deepEqual(toolLocale("fr", "cortex_locale=en"), { locale: "fr", remember: true });
  assert.deepEqual(toolLocale(null, "a=1; cortex_locale=fr"), { locale: "fr", remember: false });
  assert.deepEqual(toolLocale(null, null), { locale: "en", remember: false });
  assert.deepEqual(toolLocale("de", null), { locale: "en", remember: false });
  assert.equal(withLocaleCookie("a=1; cortex_locale=en; b=2", "fr"), "a=1; b=2; cortex_locale=fr");
  assert.equal(isToolPath("/whats-on-my-exam/r/abc"), true);
  assert.equal(isToolPath("/api/exam-topics"), true);
  assert.equal(isToolPath("/whats-on-my-examples"), false);
  assert.equal(isToolPath("/compte"), false);
});

test("public : robots laisse indexer la page de l'outil", async () => {
  const robots = (await import("../app/robots")).default();
  const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
  assert.ok(([] as string[]).concat(rules[0]!.allow ?? []).includes("/whats-on-my-exam"));
});

test("analyse : les pages blanches d'une annale en texte (pages de réponse) ne partent pas en image", async (t) => {
  const { findPdftoppm } = await import("../lib/pdftoppm");
  if (!findPdftoppm()) return t.skip("pdftoppm absent");
  const { admitRun } = await import("../lib/exam-topics/runs");
  const { processRun } = await import("../lib/exam-topics/analyze");
  const run = await admitRun({ ip: "198.51.100.35" });
  assert.ok(run.ok);
  const dir = await stage(run.id, { "0.pdf": pdfOf(["Problem 1 (10 pts) Run Dijkstra from s on the graph below", "", "", "Problem 2 (10 pts) Prove Dijkstra is correct", ""]) });
  responder = examModel;
  await processRun(run.id, dir, "en");
  assert.equal(prompts.some((p) => p.includes("data:image")), false);
});
