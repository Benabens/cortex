/**
 * NOTIONS D'UN COURS À LA PRÉPARATION — cas de prod HUM-285 (27/10 → 02/11) :
 * la grille d'évaluation de l'essai, classée midterm, et les archives du poster
 * (type note) avaient donné des notions « SHS Conceptual Link (D1) »,
 * « Precise Concept Vocabulary »…, en anglais dans un cours en français. La
 * grille reclassée en exam_info, une re-préparation gardait ces notions : sans
 * annale, ni l'index des exercices ni les notions de la passe d'avant n'étaient
 * vidés.
 * Verrouillé, avec un faux modèle (aucune dépense) :
 *  - re-préparer sans annale vide l'index et les notions qui n'en sortent plus,
 *    sauf celles que l'étudiant a travaillées ;
 *  - consignes d'examen et questions d'exemple ne nourrissent jamais les notions ;
 *  - une notion est de la matière, jamais un critère d'évaluation ou la forme d'un rendu ;
 *  - libellés dans la langue du cours.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-prepare-notions-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

/** Les notions que rend la passe d'analyse (« carte d'examen ») du faux modèle. */
const blueprint = [
  { label: "Alignement des systèmes d'IA", method: "distinguer alignement interne et externe", category: "Sécurité de l'IA", exam_weight: 60, exam_count: 0, source: "cours" },
  { label: "Souveraineté des données", method: "qui contrôle les données d'un territoire", category: "Souveraineté", exam_weight: 40, exam_count: 0, source: "cours" },
];
const blueprintPrompts: string[] = [];

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const content = (JSON.parse(body).messages as { content: unknown }[]).map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      let text = "{}";
      if (/CARTE D'EXAMEN/.test(content)) { blueprintPrompts.push(content); text = JSON.stringify({ topics: blueprint }); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { blueprintPrompts.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const GRILLE = "D1 Lien conceptuel SHS : l'essai relie la question à un concept des sciences humaines. D2 Vocabulaire conceptuel précis. D3 Argumentation étayée par la bibliographie.";
const EXEMPLE = "Question d'exemple : lequel de ces énoncés décrit le mieux un nudge numérique ?";

let courseN = 0;
/** Un cours SANS annale, au terme d'une préparation où la grille était encore classée midterm. */
async function hum285(language = "fr"): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { ensureIndexSchema } = await import("../lib/exam-index");
  const { ensureProgramSchema } = await import("../lib/program");
  const row = buildCourseRow({ name: `Enjeux mondiaux ${++courseN}`, code: "HUM-285", language, examFormat: { kind: "qcm", questionCount: 20 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    await ensureProgramSchema();
    await ensureIndexSchema();
    const add = async (type: string, title: string, text: string) => {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, `${type}/${title}`, null, 1);
      await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, type, title, text);
    };
    await add("course_pdf", "Sécurité IA et responsabilités mondiales", "Alignement interne : les objectifs du système suivent ce que veulent ses concepteurs. Alignement externe : ils suivent les valeurs de la société.");
    await add("exam_info", "HUM285 grille eval quest essai 2025", GRILLE);
    await add("sample_questions", "Exemples de questions", EXEMPLE);
    // Restes de la préparation précédente : l'index tiré de la grille et ses notions.
    await q.run(`INSERT INTO exam_exercises (exam_title, topic, statement) VALUES (?,?,?)`, "HUM285 grille eval quest essai 2025", "SHS Conceptual Link (D1)", "D1");
    for (const [label, source] of [["SHS Conceptual Link (D1)", "final"], ["Precise Concept Vocabulary", "final"], ["Poster Bibliography Formatting", "cours"], ["Biais cognitifs", "cours"]]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count, source) VALUES (?,?,?,?,?)`, label, null, 25, source === "final" ? 2 : 0, source);
    }
    // L'étudiant a travaillé « Biais cognitifs » : sa maîtrise ne disparaît pas avec la re-préparation.
    const practiced = await q.get<{ id: number }>(`SELECT id FROM topics WHERE label = ?`, "Biais cognitifs");
    await q.run(`INSERT INTO mastery (topic_id, score, attempts, ease, interval_days) VALUES (?,?,?,?,?)`, practiced!.id, 6, 1, 2.5, 2);
  });
  return row.id;
}

test("re-préparer un cours sans annale : l'index et les notions de la passe d'avant ne survivent pas", async () => {
  const id = await hum285();
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { rebuildBlueprintFromIndex } = await import("../lib/program");
  await runWithCourse(id, () => rebuildBlueprintFromIndex());
  const labels = await runWithCourse(id, async () => (await q.all<{ label: string }>(`SELECT label FROM topics ORDER BY label`)).map((r) => r.label));
  assert.deepEqual(labels, ["Alignement des systèmes d'IA", "Biais cognitifs", "Souveraineté des données"]);
  const index = await runWithCourse(id, () => q.get<{ n: number }>(`SELECT count(*) n FROM exam_exercises`));
  assert.equal(Number(index!.n), 0, "l'index tiré de la grille est vidé");
});

test("les notions viennent de la matière : ni consignes d'examen, ni questions d'exemple, ni critères d'évaluation", async () => {
  const id = await hum285();
  const { runWithCourse } = await import("../db/client");
  const { rebuildBlueprintFromIndex } = await import("../lib/program");
  await runWithCourse(id, () => rebuildBlueprintFromIndex());
  assert.equal(blueprintPrompts.length, 1);
  const prompt = blueprintPrompts[0];
  assert.match(prompt, /Alignement interne : les objectifs du système/, "les supports du cours sont lus");
  assert.ok(!prompt.includes("Lien conceptuel SHS"), "la grille d'évaluation (exam_info) n'est pas lue");
  assert.ok(!prompt.includes("nudge numérique"), "les questions d'exemple (sample_questions) ne sont pas lues");
  assert.match(prompt, /MATIÈRE DU COURS SEULEMENT[^\n]*grille ou critères d'évaluation[^\n]*forme d'un rendu/, "une notion n'est jamais un critère d'évaluation ni la forme d'un rendu");
});

test("libellés des notions dans la langue du cours", async () => {
  const { runWithCourse } = await import("../db/client");
  const { rebuildBlueprintFromIndex } = await import("../lib/program");
  const fr = await hum285("fr");
  await runWithCourse(fr, () => rebuildBlueprintFromIndex());
  const en = await hum285("en");
  await runWithCourse(en, () => rebuildBlueprintFromIndex());
  const [pFr, pEn] = blueprintPrompts;
  assert.doesNotMatch(pFr, /EN ANGLAIS/);
  assert.match(pFr, /"label" COURT, en français/, "cours en français : libellés en français");
  assert.match(pEn, /"label" COURT, en anglais/, "cours en anglais : libellés en anglais, comme avant");
});
