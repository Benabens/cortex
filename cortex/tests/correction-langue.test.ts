/**
 * LANGUE DE LA CORRECTION (audit i18n du 16/11/2026, #4 et #25). La correction d'une réponse
 * (web et connecteur check_answer) arrivait toujours « en français », même pour un cours en
 * allemand et une réponse en anglais. Verrouillé : le correcteur répond dans la langue de la
 * réponse de l'étudiant, à défaut dans celle de l'examen ; le barème de repli suit la langue de
 * l'examen ; un établissement vide ne laisse pas « () » dans le prompt. Cours FICTIFS, faux
 * fournisseur local (aucun appel payant).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-correction-langue-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

const prompts: string[] = [];
/** Réponse du faux correcteur : l'ancien contrat sans barème force le repli. */
let reply: Record<string, unknown> = {};
let llm: http.Server;
const ids: Record<"de" | "en", string> = { de: "", en: "" };

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const content = (JSON.parse(body).messages as { content: unknown }[]).map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      prompts.push(content);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const de = buildCourseRow({ name: "Erfundene Mechanik", code: "ERF-110", language: "de" }, "owner");
  const en = buildCourseRow({ name: "Imaginary Optics", code: "IMG-120", university: "Testville University", language: "en" }, "owner");
  await insertCourse(de);
  await insertCourse(en);
  await reloadCourses();
  ids.de = de.id;
  ids.en = en.id;
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function check(lang: "de" | "en", answer: string) {
  const { runWithCourse } = await import("../db/client");
  const { checkSolution } = await import("../lib/check-solution");
  prompts.length = 0;
  const result = await runWithCourse(ids[lang], () => checkSolution({ statement: "Compute 2 + 3.", answer }));
  return { result, prompt: prompts.join("\n") };
}

test("la correction suit la langue de la réponse, à défaut celle de l'examen, jamais le français imposé", async () => {
  reply = { verdict: "correct", feedback: "ok", correct_solution: "5", criteria: [
    { label: "a", points: 1, achieved: true, essential: true, justification: "x" },
    { label: "b", points: 1, achieved: true, essential: false, justification: "y" },
  ] };
  const { prompt } = await check("de", "It is 5.");
  assert.doesNotMatch(prompt, /en français/);
  assert.match(prompt, /dans la langue de la réponse de l'étudiant/);
  assert.match(prompt, /sinon en allemand/);
});

test("un établissement vide ne laisse pas de parenthèses vides dans le prompt", async () => {
  const de = await check("de", "5");
  assert.doesNotMatch(de.prompt, /\(\)/);
  assert.match(de.prompt, /correcteur rigoureux de ERF-110 Erfundene Mechanik\./);
  const en = await check("en", "5");
  assert.match(en.prompt, /IMG-120 Imaginary Optics \(Testville University\)/);
});

test("le barème de repli est écrit dans la langue de l'examen", async () => {
  reply = { verdict: "partial", feedback: "Half right.", correct_solution: "5" };
  const en = await check("en", "4 or 5");
  assert.deepEqual(en.result.criteria.map((c) => c.label), ["The approach addresses the problem", "The answer is correct and complete"]);
  const de = await check("de", "4 oder 5");
  assert.deepEqual(de.result.criteria.map((c) => c.label), ["Der Lösungsweg geht auf die Aufgabe ein", "Die Antwort ist richtig und vollständig"]);
});

test("le barème de repli couvre toutes les langues d'examen, l'anglais sinon", async () => {
  const { parseCheckResult } = await import("../lib/check-solution");
  const legacy = JSON.stringify({ verdict: "partial", feedback: "x", correct_solution: "5" });
  const { LANGUAGES } = await import("../lib/exam-format");
  const english = parseCheckResult(legacy, "en").criteria[0].label;
  for (const l of LANGUAGES.filter((x) => x !== "en")) assert.notEqual(parseCheckResult(legacy, l).criteria[0].label, english, l);
  assert.equal(parseCheckResult(legacy, "xx").criteria[0].label, english);
  assert.equal(parseCheckResult(legacy, "it").criteria[1].label, "La risposta è corretta e completa");
});
