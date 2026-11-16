/**
 * NOMBRE D'OPTIONS D'UN QCM — celui de l'annale (audit 3, P0-3, 16/11/2026).
 * Une annale à cinq options (A–E) ressortait en QCM à quatre ou cinq options au hasard du modèle,
 * et un vrai/faux à deux options n'était pas reproductible : le schéma demandait « 4 à 5 options ».
 * Ici : le nombre détecté dans l'annale est imposé au modèle (consigne et schéma), une question
 * qui ne le respecte pas n'entre jamais dans l'examen (son sujet est comblé), et sans nombre
 * connu rien ne change. Cours et annales fictifs, fournisseur LLM simulé : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-options-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

type Raw = { topic: string; type: string; stem: string; options: string[]; correct: number[]; misconceptions: string[]; explanation: string };

const STATEMENTS = [
  "A nudge steers a choice without forbidding any option or changing its cost.",
  "A nudge forbids the options judged harmful to the person choosing.",
  "A nudge changes the cost of options through a targeted tax or subsidy.",
  "A nudge imposes the default option with no way to opt out.",
  "A nudge removes every option except the one preferred by the designer.",
];

/** Une question à `k` options (k = 2 : vrai/faux) ; la première est la clé (marquée « (key) » pour le faux juge). */
function item(n: number, k: number): Raw {
  const options = k === 2 ? ["True (key)", "False"] : STATEMENTS.slice(0, k).map((o, i) => (i === 0 ? `${o} (key)` : o));
  return {
    topic: "Digital nudges",
    type: "scq",
    stem: k === 2 ? `True or false: a nudge preserves freedom of choice. (q${n})` : `According to the course, what distinguishes a nudge from a mandate? (q${n})`,
    options,
    correct: [0],
    misconceptions: options.map((_, i) => (i === 0 ? "" : "[near-synonym] confuses nudge and constraint")),
    explanation: "A nudge preserves freedom of choice: it removes no option and does not change its cost, unlike a ban or a tax.",
  };
}

let design: (n: number, call: number) => Raw[] = () => [];
let designCalls = 0;
const designBodies: string[] = [];

function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const index = Number(/^Q(\d+)\./.exec(b)![1]);
    const correct = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].filter((m) => /\(key\)/.test(m[2])).map((m) => Number(m[1]));
    return { index, correct, ok: true, discrimination: 4, name_only: false, issue: "", course_terms: [], off_course: "", off_course_terms: [], off_matter: "" };
  });
  return JSON.stringify({ results });
}

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      let text = "{}";
      if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content) || /"items"/.test(body)) {
        designCalls++;
        designBodies.push(body);
        text = JSON.stringify({ items: design(Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1), designCalls) });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => {
  designCalls = 0;
  designBodies.length = 0;
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
/** Cours fictif en anglais, une annale 100 % QCM à réponse unique ; `options` : le nombre d'options détecté (absent : inconnu). */
async function course(options?: number): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Choice architecture ${++courseN}`, code: "BEH 101", language: "en" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics", "format_profile"]) await q.ensureTable(t);
    const text = "Digital nudges: a nudge is an indirect incentive that steers a choice without forbidding any option or changing its cost.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Nudges", "course_pdf/nudges", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Nudges", text);
    await indexItemForSearch(iid, sid, "Nudges", text);
    const fid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Final 2025", "final/2025", 2025, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, fid, "exercise", "Final 2025", "Final exam. For each of the following questions, choose the one correct answer.");
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({
      format_summary: "single-answer multiple-choice questions", duration_min: 60, total_points: 3, has_mcq: true, scq_vs_mcq_convention: "",
      question_types: [{ type: "scq", approx_count: 3, share_pct: 100 }], sections: [], topics_emphasis: [],
      ...(options ? { options_per_question: options } : {}),
    }));
    for (const label of ["Digital nudges", "Choice architecture", "Libertarian paternalism"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

async function exam(id: string, count: number) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  return runWithCourse(id, async () => {
    const r = await generateQcmExam({ count, openCount: 0 });
    return { r, view: (await getQcmExam(r.id, true))! };
  });
}

test("annale à cinq options (A–E) : consigne et schéma en exigent cinq, une question à quatre options est écartée et comblée", async () => {
  const id = await course(5);
  design = (n, call) => Array.from({ length: n }, (_, i) => item(call * 10 + i, call === 1 && i === 0 ? 4 : 5));
  const { r, view } = await exam(id, 3);
  assert.equal(r.count, 3, "le sujet de la question à quatre options est comblé");
  for (const it of view.items) assert.equal(it.options.length, 5, it.stem);
  assert.ok(!view.items.some((it) => /\(q10\)/.test(it.stem)), "la question à quatre options n'entre pas dans l'examen");
  assert.match(designBodies[0], /EXACTEMENT 5 options/);
  assert.match(designBodies[0], /minItems\W+5\b/);
  assert.match(designBodies[0], /maxItems\W+5\b/);
});

test("annale vrai/faux : des questions à deux options sont acceptées telles quelles", async () => {
  const id = await course(2);
  design = (n, call) => Array.from({ length: n }, (_, i) => item(call * 10 + i, 2));
  const { r, view } = await exam(id, 3);
  assert.equal(r.count, 3);
  for (const it of view.items) assert.equal(it.options.length, 2, it.stem);
  assert.match(designBodies[0], /EXACTEMENT 2 options/);
});

test("sans nombre d'options connu : quatre ou cinq options passent, comme avant", async () => {
  const id = await course();
  design = (n, call) => Array.from({ length: n }, (_, i) => item(call * 10 + i, i % 2 ? 5 : 4));
  const { r } = await exam(id, 3);
  assert.equal(r.count, 3);
  assert.doesNotMatch(designBodies[0], /EXACTEMENT \d options/);
});

test("le nombre d'options détecté se lit dans le format résolu ; une valeur hors de 2 à 8 est ignorée", async () => {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  assert.equal((await runWithCourse(await course(5), () => resolveExamFormat())).optionsPerQuestion, 5);
  assert.equal((await runWithCourse(await course(2), () => resolveExamFormat())).optionsPerQuestion, 2);
  assert.equal((await runWithCourse(await course(12), () => resolveExamFormat())).optionsPerQuestion, null);
  assert.equal((await runWithCourse(await course(), () => resolveExamFormat())).optionsPerQuestion, null);
});

test("vrai/faux : l'option fausse est la négation de la clé, jamais un distracteur « trivial » à réécrire", async () => {
  const { applyFinalQualityVerdicts } = await import("../lib/qcm");
  const tf = { options: ["True", "False"], correct: [0], trivialDistractors: [1] };
  const [kept] = applyFinalQualityVerdicts([tf], [{ index: 0, key: true, offCourse: false, trivial: [1] }]);
  assert.equal(kept.trivialDistractors, null);
  const four = { options: STATEMENTS.slice(0, 4), correct: [0] };
  assert.deepEqual(applyFinalQualityVerdicts([four], [{ index: 0, key: true, offCourse: false, trivial: [2] }])[0].trivialDistractors, [2]);
});
