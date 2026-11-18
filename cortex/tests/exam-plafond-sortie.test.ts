/**
 * PLAFOND DE SORTIE DES APPELS D'EXAMEN ÉCRIT (banc cs-202-ecrit du 16 au 17/11, toutes les bandes) :
 * le banc (claude-code) ignore max_tokens, la prod (API) l'applique. Sortie réelle mesurée : un lot
 * jusqu'à 62 k tokens (57 % des lots au-dessus de 32 k), une régénération 30 k en moyenne (100 %
 * au-dessus des 16 k par défaut), une vérification qui trouve une erreur et réécrit le corrigé
 * 19 k en moyenne (65 % au-dessus de 16 k). En prod, ces appels étaient coupés : facturés, puis
 * perdus — régénération impossible, et l'exercice jugé faux livré « non vérifié » avec son corrigé faux.
 * Faux /v1/messages Anthropic (aucune dépense) : le faux modèle a BESOIN de la sortie mesurée au
 * banc et rend une réponse coupée (stop_reason max_tokens) si la limite demandée est plus basse.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-plafond-sortie-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "sk-ant-test";
process.env.LLM_MAX_RETRIES = "0";

/** Sortie maximale mesurée au banc, par étape (17/11). */
const NEED = { lot: 62_000, regeneration: 42_000, rejet: 36_000, accord: 24_000 };

const STATEMENT = String.raw`\subq{1.1}{Délai}{5} Calculez le délai de bout en bout.
\subq{1.2}{Tailles inégales}{5} Donnez la formule générale du délai du dernier paquet.`;
const WRONG = String.raw`\subq{1.1}{Délai}{5} $7{,}2$ ms. \subq{1.2}{Tailles inégales}{5} $T = (N-1) L_P/R$.`;
const RIGHT = String.raw`\subq{1.1}{Délai}{5} $7{,}2$ ms. \subq{1.2}{Tailles inégales}{5} $T = \max_j [(N-1) L_j/R + \sum_{m \ge j} L_m/R]$.`;
const exercise = (i = 1) => ({ category: "Réseaux", concept: `Store-and-forward ${i}`, statement_tex: STATEMENT, solution_tex: WRONG, points: 10 });

/** Réponse du faux modèle à une demande : étape, sortie dont elle a besoin, texte complet. */
function answer(text: string): { step: string; need: number; reply: string } {
  const lot = /LES (\d+) EXERCICES À PRODUIRE/.exec(text);
  if (lot) return { step: "lot", need: NEED.lot, reply: JSON.stringify({ questions: Array.from({ length: Number(lot[1]) }, (_, i) => ({ ...exercise(i + 1), solution_tex: RIGHT })) }) };
  if (/Régénère UN SEUL/.test(text)) return { step: "regeneration", need: NEED.regeneration, reply: JSON.stringify({ ...exercise(), solution_tex: RIGHT }) };
  // vérification : le corrigé proposé faux est rejeté (corrigé complet réécrit), le bon est accepté.
  if (text.includes("L_P/R")) {
    return { step: "verification", need: NEED.rejet, reply: JSON.stringify({ my_solution: "1.2 : le premier paquet est le goulot.", verdict: "wrong", issue: "1.2 faux.", corrected_solution_tex: RIGHT, violates_exclusion: false, too_easy: false }) };
  }
  return { step: "verification", need: NEED.accord, reply: JSON.stringify({ my_solution: "1.2 : max sur j.", verdict: "ok", issue: "", violates_exclusion: false, too_easy: false }) };
}

const calls = new Map<string, number>();
let llm: http.Server;

function sse(res: http.ServerResponse, text: string, cut: number | null) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: cut === null ? text : text.slice(0, 40) } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: cut === null ? "end_turn" : "max_tokens", stop_sequence: null }, usage: { output_tokens: cut ?? 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  delete process.env.CORTEX_USER;
  delete process.env.CORTEX_TEST_STUB_BATCH;
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { max_tokens?: number; system?: { text: string }[]; messages: { content: { type: string; text?: string }[] }[] };
      const text = [...(body.system ?? []).map((s) => s.text), ...body.messages.flatMap((m) => m.content.map((c) => c.text ?? ""))].join("\n");
      const { step, need, reply } = answer(text);
      calls.set(step, (calls.get(step) ?? 0) + 1);
      const limit = body.max_tokens ?? 0;
      sse(res, reply, limit < need ? limit : null);
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { calls.clear(); });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("une régénération d'exercice a la place de finir (42 k tokens de sortie au banc)", async () => {
  const { runWithCourse } = await import("../db/client");
  const { regenerateExercise } = await import("../lib/exam");
  const q = await runWithCourse("ml", () => regenerateExercise(exercise(), "1.2 faux"));
  assert.equal(q.solution_tex, RIGHT);
});

test("une vérification qui trouve l'erreur et réécrit le corrigé a la place de finir : l'exercice est livré corrigé, pas « non vérifié »", async () => {
  const { runWithCourse } = await import("../db/client");
  const { verifyAndHarden } = await import("../lib/verify");
  const { spec, report } = await runWithCourse("ml", () => verifyAndHarden({ title: "", questions: [exercise()] }, async () => { throw new Error("pas de régénération ici"); }, 2));
  assert.equal(report.results[0].verified, 1, `verdict : ${JSON.stringify(report.results[0])}`);
  assert.equal(spec.questions[0].solution_tex, RIGHT);
});

test("un lot de 2 exercices a la place de finir d'un seul appel (62 k tokens de sortie au banc)", async () => {
  const { runWithCourse } = await import("../db/client");
  const { generateExamViaClaudeCode } = await import("../lib/exam");
  const r = await runWithCourse("ml", () => generateExamViaClaudeCode({ count: 2, verify: false }));
  assert.equal(r.produced, 2);
  assert.equal(calls.get("lot"), 1, "aucun lot coupé puis refait exercice par exercice");
});
