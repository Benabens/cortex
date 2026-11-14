/**
 * LOT TRONQUÉ (prod du 13/11, cours test-e2e-calcul-matriciel, job 2) : un lot de
 * 2 exercices à 5 sous-questions dépassait la limite de sortie du modèle
 * (« Réponse du modèle coupée par la limite de longueur »). Le même lot de 2 était
 * redemandé 9 fois à l'identique (3 essais JSON × 2 essais de lot, puis le
 * comblement, encore par 2) et l'examen sortait à 2 questions sur 4.
 * Verrouillé : un lot coupé est redemandé exercice par exercice, et l'examen
 * sort complet. Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-tronque-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

/** Exercices demandés par appel (« LES n EXERCICES À PRODUIRE »), dans l'ordre des appels. */
const asked: number[] = [];
let llm: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  delete process.env.CORTEX_TEST_STUB_BATCH;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      const n = Number(/LES (\d+) EXERCICES À PRODUIRE/.exec(content)?.[1] ?? 1);
      asked.push(n);
      // Deux exercices longs ne tiennent pas dans la limite de sortie ; un seul, si.
      const finish = n > 1 ? "length" : "stop";
      const text = n > 1
        ? `{"questions":[{"category":"General","concept":"Gradient","statement_tex":"\\\\subq{1.1}{Calcul}{10} Soit $A$`
        : JSON.stringify({ questions: [{ category: "General", concept: `Exercice ${asked.length}`, statement_tex: String.raw`\subq{1.1}{Calcul}{10} Soit $A \in \mathbb{R}^{n\times n}$.`, solution_tex: "Réponse.", points: 10 }] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  llm?.close();
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("un lot coupé par la limite de longueur est redemandé exercice par exercice : 4 exercices sur 4", async () => {
  const { runWithCourse } = await import("../db/client");
  const { generateExamViaClaudeCode } = await import("../lib/exam");
  const steps: string[] = [];
  const r = await runWithCourse("ml", () => generateExamViaClaudeCode({ count: 4, verify: false, onStep: (s) => { steps.push(s); } }));
  assert.equal(r.requested, 4);
  assert.equal(r.produced, 4, steps.filter((s) => /Lot|manquant|PARTIEL|Comblement/.test(s)).join("\n"));
  // Un lot coupé n'est pas redemandé tel quel : au plus un appel à 2 exercices par lot.
  assert.ok(asked.filter((n) => n > 1).length <= 2, `appels par taille de lot : ${asked.join(",")}`);
});
