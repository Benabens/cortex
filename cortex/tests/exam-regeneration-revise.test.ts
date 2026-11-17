/**
 * RÉGÉNÉRATION = RÉVISION DE L'EXERCICE REJETÉ (examen écrit, lib/exam regenerateExercise) — banc
 * cs-202-ecrit du 17/11 (e0) : la régénération recevait le diagnostic du vérificateur (« 1.3 : la
 * formule suppose… ») sans l'exercice qu'il décrit, et concevait un exercice neuf (27,6 k tokens de
 * sortie en moyenne), avec ses propres erreurs à revérifier. Elle révise désormais l'énoncé et le
 * corrigé rejetés ; un exercice hors programme, lui, est remplacé par un exercice neuf.
 * Faux /v1/messages Anthropic (aucune dépense) : le faux modèle ne peut réviser que ce qu'il voit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-regen-revise-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "sk-ant-test";
process.env.LLM_MAX_RETRIES = "0";

const STATEMENT = String.raw`\textbf{Contexte.} Trois paquets traversent deux routeurs store-and-forward.
\subq{1.1}{Délai}{5} Calculez le délai de bout en bout du premier paquet.
\subq{1.2}{Tailles inégales}{5} Donnez la formule générale du délai du dernier paquet.`;
const WRONG = String.raw`\subq{1.1}{Délai}{5} $7{,}2$ ms. \subq{1.2}{Tailles inégales}{5} $T = (N-1) L_P/R$.`;
const RIGHT = String.raw`\subq{1.1}{Délai}{5} $7{,}2$ ms. \subq{1.2}{Tailles inégales}{5} $T = \max_j [(N-1) L_j/R + \sum_{m \ge j} L_m/R]$.`;
const FRESH = String.raw`\subq{1.1}{Pagination}{10} Traduisez l'adresse virtuelle 0x3A7F.`;
const exercise = () => ({ category: "Réseaux", concept: "Store-and-forward", statement_tex: STATEMENT, solution_tex: WRONG, points: 10 });

let llm: http.Server;

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { system?: { text: string }[]; messages: { content: { type: string; text?: string }[] }[] };
      const text = [...(body.system ?? []).map((s) => s.text), ...body.messages.flatMap((m) => m.content.map((c) => c.text ?? ""))].join("\n");
      if (/Régénère UN SEUL/.test(text)) {
        // Le faux modèle révise l'exercice qu'il voit, ou en écrit un autre s'il ne le voit pas.
        const sees = text.includes("Trois paquets traversent deux routeurs") && text.includes("(N-1) L_P/R");
        sse(res, JSON.stringify(sees
          ? { category: "Réseaux", concept: "Store-and-forward", statement_tex: STATEMENT, solution_tex: RIGHT, points: 10 }
          : { category: "OS", concept: "Pagination", statement_tex: FRESH, solution_tex: "0x1A7F.", points: 10 }));
        return;
      }
      // Vérificateur : l'exercice de réseau est hors programme tant que le cours n'en parle pas (2e test).
      if (text.includes("Trois paquets traversent deux routeurs")) {
        sse(res, JSON.stringify({ my_solution: "Hors programme.", verdict: "ok", issue: "Les réseaux sont exclus.", violates_exclusion: true, too_easy: false }));
        return;
      }
      sse(res, JSON.stringify({ my_solution: "0x1A7F.", verdict: "ok", issue: "", violates_exclusion: false, too_easy: false }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("un exercice rejeté pour une erreur de corrigé est révisé : même énoncé, corrigé refait", async () => {
  const { runWithCourse } = await import("../db/client");
  const { regenerateExercise } = await import("../lib/exam");
  const q = await runWithCourse("ml", () => regenerateExercise(exercise(), "1.2 : la formule suppose que le dernier paquet est le plus gros."));
  assert.equal(q.statement_tex, STATEMENT, "l'énoncé rejeté est révisé, pas remplacé");
  assert.equal(q.solution_tex, RIGHT);
});

test("un exercice hors programme est remplacé par un exercice neuf, pas révisé", async () => {
  const { runWithCourse } = await import("../db/client");
  const { verifyAndHarden } = await import("../lib/verify");
  const { regenerateExercise } = await import("../lib/exam");
  const { spec, report } = await runWithCourse("ml", () => verifyAndHarden({ title: "", questions: [exercise()] }, regenerateExercise, 2));
  assert.equal(spec.questions[0].statement_tex, FRESH);
  assert.equal(report.results[0].verified, 1);
});
