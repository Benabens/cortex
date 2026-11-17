/**
 * CORRIGÉ COMPLET APRÈS VÉRIFICATION (examen écrit, lib/verify verifyAndHarden) — banc du 16/11
 * (ex9, cs-202-ecrit, 2 runs sur 3) : le vérificateur juge faux UNE sous-question et renvoie une
 * correction partielle (« 1.1 à 1.4 et 1.5a : inchangés », puis la seule sous-question refaite) ;
 * la régénération expire, et cette correction remplace le corrigé entier : l'exercice est livré
 * « corrigé » avec un corrigé qui ne traite plus qu'une sous-question.
 * Faux /v1/messages Anthropic (aucune dépense) ; la régénération est injectée.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-corrige-complet-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "sk-ant-test";
process.env.LLM_MAX_RETRIES = "0";

const STATEMENT = String.raw`\textbf{Contexte.} Trois paquets traversent deux routeurs store-and-forward.
\subq{1.1}{Délai d'un paquet}{3} Calculez le délai de bout en bout du premier paquet.
\subq{1.2}{Pipeline}{3} Quand le deuxième paquet arrive-t-il ?
\subq{1.3}{Tailles inégales}{4} Donnez la formule générale du délai du dernier paquet.`;

const ORIGINAL = String.raw`\subq{1.1}{Délai d'un paquet}{3} $T_1 = 3 \times 1{,}5 + 3 \times 0{,}9 = 7{,}2$ ms.
\subq{1.2}{Pipeline}{3} Le deuxième paquet suit à $0{,}5$ ms : $T_2 = 7{,}7$ ms.
\subq{1.3}{Tailles inégales}{4} $T = \sum_i L_i/R + (N-1) L_P/R + N d_{prop} = 8{,}2$ ms.`;

const PARTIAL = String.raw`\textbf{1.1 et 1.2} : inchangés par rapport au corrigé proposé (corrects).\\
\subq{1.3}{Tailles inégales}{4} La formule n'est valable que si le dernier paquet est le plus gros ; en général $T = N d_{prop} + \max_j [(N-1) L_j/R + \sum_{m \ge j} L_m/R] = 8{,}7$ ms.`;

const COMPLETE = String.raw`\subq{1.1}{Délai d'un paquet}{3} $T_1 = 3 \times 1{,}5 + 3 \times 0{,}9 = 7{,}2$ ms.
\subq{1.2}{Pipeline}{3} Le deuxième paquet suit à $0{,}5$ ms : $T_2 = 7{,}7$ ms.
\subq{1.3}{Tailles inégales}{4} En général $T = N d_{prop} + \max_j [(N-1) L_j/R + \sum_{m \ge j} L_m/R] = 8{,}7$ ms.`;

/** Correction que renvoie le faux vérificateur pour le test en cours. */
let correction = PARTIAL;
/** La revérification d'un corrigé déjà corrigé l'accepte-t-elle ? (sinon le faux vérificateur rejette toujours) */
let reverifyAgrees = false;
/** Temps que met le faux modèle à rendre une régénération. */
const REGEN_DELAY_MS = 1500;
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
      if (/Régénère UN SEUL/.test(raw)) {
        setTimeout(() => { if (!res.destroyed) sse(res, JSON.stringify({ category: "Réseaux", concept: "Store-and-forward", statement_tex: STATEMENT, solution_tex: COMPLETE, points: 10 })); }, REGEN_DELAY_MS);
        return;
      }
      // Le corrigé proposé est celui du concepteur tant qu'il garde sa formule fausse « (N-1) L_P/R ».
      if (reverifyAgrees && !raw.includes("L_P/R")) {
        sse(res, JSON.stringify({ my_solution: "T = 8,7 ms.", verdict: "ok", issue: "", violates_exclusion: false, too_easy: false }));
        return;
      }
      sse(res, JSON.stringify({
      my_solution: "En 1.3, le premier paquet (le plus gros) est le goulot : T = 8,7 ms.",
      verdict: "wrong",
      issue: "1.1 et 1.2 sont corrects ; 1.3 : la formule suppose que le dernier paquet est le plus gros.",
      corrected_solution_tex: correction,
      violates_exclusion: false,
      too_easy: false,
      }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { correction = PARTIAL; reverifyAgrees = false; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MAX_RETRIES", "LLM_BASE_URL", "CORTEX_BATCH_TIMEOUT_MS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const exercise = () => ({ category: "Réseaux", concept: "Store-and-forward", statement_tex: STATEMENT, solution_tex: ORIGINAL, points: 10 });
const failingRegeneration = async (): Promise<never> => { throw new Error("Claude Code a mis trop de temps (timeout)."); };

test("une correction partielle du vérificateur ne remplace pas le corrigé entier, et l'exercice n'est pas compté comme vérifié", async () => {
  const { runWithCourse } = await import("../db/client");
  const { verifyAndHarden } = await import("../lib/verify");
  const { spec, report } = await runWithCourse("ml", () => verifyAndHarden({ title: "", questions: [exercise()] }, failingRegeneration, 2));
  assert.equal(spec.questions.length, 1);
  assert.doesNotMatch(spec.questions[0].solution_tex, /inchang/, "le corrigé livré ne renvoie pas à des parties « inchangées »");
  assert.match(spec.questions[0].solution_tex, /\\subq\{1\.1\}/, "le corrigé livré traite encore 1.1");
  assert.equal(report.results[0].verified, 0, "un corrigé jugé faux et non corrigé n'est pas présenté comme vérifié");
  assert.equal(report.fixed, 0);
});

test("une correction complète du vérificateur remplace le corrigé faux, et l'exercice compte comme corrigé", async () => {
  correction = COMPLETE;
  const { runWithCourse } = await import("../db/client");
  const { verifyAndHarden } = await import("../lib/verify");
  const { spec, report } = await runWithCourse("ml", () => verifyAndHarden({ title: "", questions: [exercise()] }, failingRegeneration, 2));
  assert.equal(spec.questions[0].solution_tex, COMPLETE);
  assert.equal(report.results[0].verified, 1);
  assert.equal(report.fixed, 1);
});

test("un corrigé jugé faux est réparé par la correction complète du vérificateur, revérifiée, sans exercice régénéré", async () => {
  // Banc e0 (17/11) : chaque rejet porte sur UNE sous-question d'un énoncé bien posé ; la régénération
  // refaisait un exercice entier sans voir l'énoncé (0,35-0,45 $, puis sa propre revérification).
  correction = COMPLETE;
  reverifyAgrees = true;
  const regenerated = { category: "Réseaux", concept: "Exercice régénéré", statement_tex: String.raw`\subq{1.1}{Autre}{10} Autre énoncé.`, solution_tex: "Autre corrigé.", points: 10 };
  const { runWithCourse } = await import("../db/client");
  const { verifyAndHarden } = await import("../lib/verify");
  const { spec, report } = await runWithCourse("ml", () => verifyAndHarden({ title: "", questions: [exercise()] }, async () => regenerated, 2));
  assert.equal(spec.questions[0].statement_tex, STATEMENT, "l'énoncé conçu est gardé");
  assert.equal(spec.questions[0].solution_tex, COMPLETE, "le corrigé est celui du vérificateur");
  assert.equal(report.results[0].verified, 1, "le corrigé réparé a été revérifié et accepté");
  assert.equal(report.regenerated, 0);
});

test("une régénération a le même délai que la conception d'un exercice (CORTEX_BATCH_TIMEOUT_MS)", async () => {
  // ex9 : 2 régénérations sur 3 coupées à 420 s, quand la conception d'un lot a 600 s et la
  // vérification 540 s ; la régénération réussie du 3e run a pris 305 s.
  const { runWithCourse } = await import("../db/client");
  const { regenerateExercise } = await import("../lib/exam");
  const regen = () => runWithCourse("ml", () => regenerateExercise(exercise(), "1.3 faux"));
  process.env.CORTEX_BATCH_TIMEOUT_MS = String(REGEN_DELAY_MS * 4);
  assert.equal((await regen()).solution_tex, COMPLETE, "dans le délai de conception : la régénération aboutit");
  process.env.CORTEX_BATCH_TIMEOUT_MS = String(REGEN_DELAY_MS / 5);
  await assert.rejects(regen, "au-delà du délai de conception : la régénération est coupée");
});
