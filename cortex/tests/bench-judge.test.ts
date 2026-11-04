/**
 * Juge du banc (lib/bench/judge) : le solveur répond sans la clé, l'arbitre tranche, le code
 * dont dépend une clé est exécuté et sa sortie fait foi ; les rejets « hors cours » sont
 * revus dans tout le cours. Fournisseur simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { BenchRun } from "../lib/bench/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bench-judge-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

const prompts: string[] = [];
let llm: http.Server;

/** Réponse du faux modèle selon le rôle demandé par le juge. */
function reply(prompt: string): unknown {
  if (/Tu ne vois ni la clé/.test(prompt)) return { answers: [{ q: 0, chosen: [1] }, { q: 1, chosen: [0] }] };
  if (/examinateur exigeant/.test(prompt)) {
    return {
      items: [
        { q: 0, key: "wrong", explanation: "consistent", definition: "na", off_course: false, distractors: 3, trivial: [3, 0], chapter: 1, notion: "ordre des segments", code: null },
        { q: 1, key: "right", explanation: "consistent", definition: "na", off_course: false, distractors: 3, trivial: [], chapter: 99, notion: "somme", code: { language: "python", source: "print(2 + 2)", stdin: "", expected: "5" } },
      ],
    };
  }
  if (/doublons/.test(prompt)) return { intra: [[0, 1], [1, 1]], previous: [1] };
  if (/écarté ces questions/.test(prompt)) return { items: [{ q: 0, in_course: true }] };
  return {};
}

before(async () => {
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const prompt = String((JSON.parse(body).messages as { content: string }[]).at(-1)?.content);
      prompts.push(prompt);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(prompt)) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = {
  exam: {
    id: 1, kind: "qcm", items: [
      { idx: 0, kind: "qcm", topic: "t", stem: "Quel protocole numérote les segments ?", options: ["TCP", "UDP", "IP", "ICMP"], correct: [0], explanation: "TCP numérote." },
      { idx: 1, kind: "qcm", topic: "t", stem: "Que vaut la sortie de print(2 + 2) ?", options: ["4", "5", "22", "Erreur"], correct: [1], explanation: "Elle affiche 5." },
    ],
  },
  plan: { chapters: [{ id: 1, seq: 1, title: "Transport" }], topicChapter: {} },
  previous: [{ stem: "Que vaut print(2 + 2) ?", topic: null }],
  rejected: [
    { stem: "Que garantit TCP ?", options: ["l'ordre", "rien"], correct: [0], reason: "hors cours : absent du cours : ordre" },
    { stem: "Explication par position", options: ["a", "b"], correct: [0], reason: "explication qui désigne une option par sa position ou sa lettre" },
  ],
} as unknown as BenchRun;

test("juge : arbitre, code exécuté, doublons et faux rejets ; la clé n'est jamais montrée au solveur", async () => {
  const { runWithCourse } = await import("../db/client");
  const { judgeExam } = await import("../lib/bench/judge");
  const { sandboxAvailable } = await import("../lib/sandbox-exec");
  const v = await runWithCourse("ml", () => judgeExam(run));

  const solverPrompt = prompts.find((p) => /Tu ne vois ni la clé/.test(p)) ?? "";
  assert.doesNotMatch(solverPrompt, /CLÉ|EXPLICATION|TCP numérote/);
  assert.match(prompts.find((p) => /examinateur exigeant/.test(p)) ?? "", /SOLVEUR INDÉPENDANT : 1/);

  assert.equal(v.items[0].key, "wrong");
  // L'indice 0 est la bonne réponse : jamais compté comme distracteur trivial.
  assert.equal(v.items[0].trivialDistractors, 1);
  assert.equal(v.items[0].chapter, 1);
  assert.equal(v.items[1].chapter, null, "un chapitre hors du plan n'est pas retenu");
  if (sandboxAvailable()) {
    assert.deepEqual([v.items[1].code?.ran, v.items[1].code?.ok, v.items[1].key], [true, false, "wrong"], "la sortie réelle (4) contredit la clé (5)");
  }
  assert.deepEqual(v.duplicatesIntra, [[0, 1]]);
  assert.deepEqual(v.duplicatesPrevious, [1]);
  assert.deepEqual(v.rejected, [{ idx: 0, offCourseReject: true, falseRejection: true }, { idx: 1, offCourseReject: false, falseRejection: false }]);
  assert.match(v.rubric, /^v1:/);
});
