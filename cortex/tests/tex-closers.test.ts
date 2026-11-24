/**
 * ACCOLADE FERMÉE EN MARKDOWN (lib/tex-closers) — banc Opus 5.5 high du 23-24/11/2026, CS-202 écrit,
 * 5 passages : 14 des 26 rejets du vérificateur disaient « le fond est juste, le LaTeX ne compile pas »
 * (« \emph{aussi* perdu », « \textbf{désactivé** : », « \texttt{arg`. ») ; chaque rejet régénérait
 * l'exercice juste en entier. Rejeu sur les 458 énoncés et corrigés des bandes : 72 déséquilibrés,
 * 69 réparés, tous rééquilibrés, aucun document sain modifié.
 * Faux /v1/messages Anthropic pour la régénération (aucune dépense).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { braceBalance, repairExerciseClosers, repairMarkdownClosers } from "../lib/tex-closers";

test("ferme les \\emph, \\textbf et \\texttt laissés ouverts par une marque markdown", () => {
  const cases: [string, string][] = [
    [String.raw`que l'ACK soit \emph{aussi* perdu.`, String.raw`que l'ACK soit \emph{aussi} perdu.`],
    [String.raw`L'algorithme de Nagle est \textbf{désactivé** : un segment part`, String.raw`L'algorithme de Nagle est \textbf{désactivé} : un segment part`],
    ["T1 y accède via le pointeur \\texttt{arg`. Les piles", "T1 y accède via le pointeur \\texttt{arg}. Les piles"],
    [String.raw`\emph{Cas little-endian :*`, String.raw`\emph{Cas little-endian :}`],
    [String.raw`assume \textbf{simple uniform hashing**. Each key`, String.raw`assume \textbf{simple uniform hashing}. Each key`],
    [String.raw`le tampon est vidé \emph{par ligne* : chaque \texttt{\textbackslash n} le vide`, String.raw`le tampon est vidé \emph{par ligne} : chaque \texttt{\textbackslash n} le vide`],
  ];
  for (const [bad, good] of cases) {
    assert.equal(braceBalance(bad), 1, bad);
    assert.equal(repairMarkdownClosers(bad), good);
    assert.equal(braceBalance(repairMarkdownClosers(bad)), 0);
  }
});

test("deux arguments ouverts sur la même ligne sont refermés tous les deux", () => {
  const bad = String.raw`\item \textbf{Version A* : on garde la base ; \emph{taille* de l'espace.`;
  assert.equal(repairMarkdownClosers(bad), String.raw`\item \textbf{Version A} : on garde la base ; \emph{taille} de l'espace.`);
});

test("un document équilibré n'est jamais touché, même avec des étoiles ou des accents graves", () => {
  for (const ok of [
    String.raw`\texttt{*p = 0} déréférence p ; \emph{a*b} reste tel quel.`,
    "\\textbf{Piège :} $3 * 4 = 12$ et \\texttt{x`}",
    // argument qui s'étend sur deux lignes, équilibré : aucune « réparation »
    "\\textbf{une note*\nsur deux lignes}",
    "",
  ]) assert.equal(repairMarkdownClosers(ok), ok);
});

test("une étoile qui ouvre (« \\texttt{*p ») ou entourée d'espaces n'est pas une fermeture", () => {
  const bad = String.raw`On lit \texttt{*p et la suite`;
  assert.equal(repairMarkdownClosers(bad), bad);
  const spaced = String.raw`\emph{a * b la suite`;
  assert.equal(repairMarkdownClosers(spaced), spaced);
});

test("le code verbatim n'est jamais réparé", () => {
  const tex = "\\begin{lstlisting}\nprintf(\"\\emph{x*\");\n\\end{lstlisting}\n\\emph{ouvert";
  assert.equal(repairMarkdownClosers(tex), tex);
});

test("jamais plus de réparations que d'accolades manquantes", () => {
  // une seule accolade manque (la seconde est fermée plus loin, sur une autre ligne)
  const tex = "\\emph{aussi* perdu\n\\textbf{note* \nfin}";
  const out = repairMarkdownClosers(tex);
  assert.equal(braceBalance(out), 0);
  assert.equal(out.split("}").length - tex.split("}").length, 1);
});

test("l'exercice garde son identité quand rien n'est à réparer", () => {
  const q = { statement_tex: "\\emph{ok}", solution_tex: "rien", points: 3 };
  assert.equal(repairExerciseClosers(q), q);
  const r = repairExerciseClosers({ statement_tex: "\\emph{aussi* perdu", solution_tex: "\\textbf{oui** (", points: 3 });
  assert.equal(r.statement_tex, "\\emph{aussi} perdu");
  assert.equal(r.solution_tex, "\\textbf{oui} (");
});

// ---- Intégration : la régénération rend un exercice déjà réparé, avant toute vérification ----

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tex-closers-"));
let llm: http.Server;
const BROKEN = {
  category: "Réseaux", concept: "TCP",
  statement_tex: String.raw`\subq{1.1}{Perte}{3} Supposez que l'ACK soit \emph{aussi* perdu.`,
  solution_tex: String.raw`\subq{1.1}{Perte}{3} Rien n'est livré : TCP livre \emph{en ordre*.`,
  points: 3,
};

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  process.env.CORTEX_DATA_DIR = tmp;
  process.env.LLM_PROVIDER = "anthropic";
  process.env.LLM_API_KEY = "sk-ant-test";
  process.env.LLM_MAX_RETRIES = "0";
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => sse(res, JSON.stringify(BROKEN)));
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

test("régénération : l'exercice rendu est déjà réparé (le vérificateur ne voit jamais l'accolade ouverte)", async () => {
  const { runWithCourse } = await import("../db/client");
  const { regenerateExercise } = await import("../lib/exam");
  const q = await runWithCourse("ml", () => regenerateExercise({ ...BROKEN, statement_tex: "x", solution_tex: "y" }, "corrigé faux"));
  assert.equal(q.statement_tex, String.raw`\subq{1.1}{Perte}{3} Supposez que l'ACK soit \emph{aussi} perdu.`);
  assert.equal(q.solution_tex, String.raw`\subq{1.1}{Perte}{3} Rien n'est livré : TCP livre \emph{en ordre}.`);
  assert.equal(braceBalance(q.statement_tex) + braceBalance(q.solution_tex), 0);
});
