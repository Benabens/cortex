/**
 * QCM ROBUSTE (chasse aux bugs du 22/11/2026).
 *  - Une question rattachée à son sujet par ce qu'elle dit tester (fact_id, topic), pas par sa
 *    place dans la réponse : un sujet sauté par le modèle décalait toutes les suivantes (notion
 *    fausse au corrigé, et le sujet sauté n'était jamais redemandé).
 *  - Une clé répétée ([0, 0]) n'est qu'une bonne réponse : comptée deux fois, elle écartait la
 *    question d'un examen à réponse unique.
 *  - Deux options qui ne diffèrent que par un opérateur (« $x^2$ » / « $x_2$ », « < » / « > »,
 *    « -1 » / « 1 », « == » / « != ») ne sont pas des doublons : le distracteur est l'erreur même.
 * Cours fictifs uniquement.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { duplicateOptionIndices } from "../lib/qcm-checks";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-robuste-"));
Object.assign(process.env, {
  CORTEX_DATA_DIR: tmp, LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5",
  LLM_MAX_RETRIES: "0", MAX_COURSES_CREATED_PER_HOUR: "unlimited", MAX_COURSES_PER_USER: "unlimited",
});

const item = (topic: string, over: Record<string, unknown> = {}) => ({
  topic, type: "scq", stem: `Question sur ${topic} ?`,
  options: ["Clé juste du cours.", "Inversion du cours.", "Mauvaise condition du cours.", "Mauvaise attribution du cours."],
  correct: [0], misconceptions: ["", "a", "b", "c"], source_fact: "x", explanation: "Le cours le dit.",
  justification: { key: "Le cours le dit.", distractors: [1, 2, 3].map((i) => ({ option_index: i, why_wrong: "Le cours dit autre chose." })) },
  ...over,
});
let reply: unknown[] = [];
let llm: http.Server;
let courseId = "";

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: reply }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const row = buildCourseRow({ name: "Cours fictif QCM robuste", code: "FIC 101", language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  courseId = row.id;
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
  });
});

after(async () => {
  await new Promise((r) => llm.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TOPICS = ["Notion A", "Notion B", "Notion C"].map((label) => ({ label, method: null }));

async function batch(topics: typeof TOPICS = TOPICS) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmBatch } = await import("../lib/qcm");
  return runWithCourse(courseId, () => generateQcmBatch(topics, topics.length, () => {}, undefined, undefined, { answerMode: "single", optionsPerQuestion: 4, passages: [], examples: [] }));
}

test("sujet sauté par le modèle : chaque question garde SON sujet, le sujet sauté reste à combler", async () => {
  reply = [item("Notion A"), item("Notion C")];
  const out = await batch();
  assert.deepEqual(out.map((it) => TOPICS[it.slot!].label), ["Notion A", "Notion C"]);
});

test("questions rendues dans le désordre : rattachées par leur sujet recopié", async () => {
  reply = [item("Notion C"), item("Notion A"), item("Notion B")];
  const out = await batch();
  assert.deepEqual(out.map((it) => [it.stem, it.slot]), [["Question sur Notion C ?", 2], ["Question sur Notion A ?", 0], ["Question sur Notion B ?", 1]]);
});

test("sujet illisible, absent ou recopié partout : la position, puis un rang resté libre (jamais deux questions sur un rang)", async () => {
  const { slotsOf } = await import("../lib/qcm");
  assert.deepEqual(slotsOf([{ topic: "?" }, { topic: "" }, {}], TOPICS, []), [0, 1, 2]);
  assert.deepEqual(slotsOf([{ topic: "Notion B" }, { topic: "autre chose" }], TOPICS, []), [1, 0]);
  assert.deepEqual(slotsOf([{ topic: "Notion B" }, { topic: "Notion B" }, { topic: "Notion B" }], TOPICS, []), [0, 1, 2], "le même sujet recopié partout ne désigne rien : la position");
  assert.deepEqual(slotsOf([{ topic: "2) Notion C — sous-thème imposé : x" }], TOPICS, []), [2]);
  assert.deepEqual(slotsOf([{ fact_id: "f-2", topic: "Notion A" }], TOPICS, [{ id: "f-1" }, { id: "f-2" }, null]), [1], "le fait recopié prime sur le libellé");
});

test("clé répétée [0, 0] : une seule bonne réponse, la question reste dans un examen à réponse unique", async () => {
  reply = [item("Notion A", { correct: [0, 0] })];
  const out = await batch([TOPICS[0]]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].correct.length, 1);
});

test("doublons d'options : un opérateur qui diffère n'est pas un doublon", () => {
  for (const [options, correct] of [
    [["$x^2$", "$x_2$", "$2x$", "$x+2$"], [0]],
    [["$x > 0$", "$x < 0$", "$x = 0$", "$x \\neq 0$"], [0]],
    [["$-1$", "$1$", "$0$", "$2$"], [1]],
    [["`a == b`", "`a != b`", "`a = b`", "`a === b`"], [0]],
    [["`i++`", "`i--`", "`++i`", "`--i`"], [0]],
  ] as [string[], number[]][]) assert.deepEqual(duplicateOptionIndices(options, correct), [], options.join(" | "));
});

test("doublons d'options : le même libellé (casse, ponctuation, espaces autour d'un opérateur) en reste un", () => {
  assert.deepEqual(duplicateOptionIndices(["Le biais de disponibilité.", "le biais de disponibilité", "Ancrage", "Cadrage"], [2]), [1]);
  assert.deepEqual(duplicateOptionIndices(["x > 0", "x>0", "y", "z"], [2]), [1]);
});
