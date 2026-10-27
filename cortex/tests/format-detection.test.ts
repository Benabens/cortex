/**
 * DÉTECTION DU FORMAT SANS ANNALE (lib/format detectFormat).
 *
 * Un cours sans annale ne fait plus échouer sa préparation : le format est
 * cherché dans les questions d'exemple officielles, puis dans les consignes
 * d'examen, puis dans les indices du corpus (« question type QCM », « une seule
 * réponse correcte »). Le modèle doit CITER ses preuves, vérifiées mot pour mot
 * dans les sources : une affirmation sans citation retrouvée vaut « inconnu ».
 * Sans aucun indice, aucun appel au modèle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-format-detect-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

/** Faux fournisseur : rend `reply` et garde les prompts reçus. */
let reply: Record<string, unknown> = {};
const prompts: string[] = [];
let llm: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { prompts.push(JSON.stringify(JSON.parse(body).messages)); } catch { prompts.push(body); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { prompts.length = 0; reply = {}; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
async function newCourse(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: `Cours détection ${++seq}` }, "owner");
  await insertCourse(row);
  await reloadCourses();
  return row.id;
}

async function addSource(course: string, type: string, title: string, text: string): Promise<void> {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithCourse(course, async () => {
    await q.ensureTable("sources");
    await q.ensureTable("items");
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, `${type}/${title}`, null, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, type, title, text);
  });
}

async function inCourse<T>(course: string, fn: () => Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(course, fn);
}

const SLIDES = "Vérifier et entreprendre. Les biais de confirmation nous poussent à chercher ce qui confirme nos croyances. " +
  "Chaque partie se termine par une question type QCM. Une seule réponse correcte. Laquelle est un nudge ? " +
  "A) Une taxe sur l'électricité B) Un mode éco activé par défaut, désactivable en un clic C) Une interdiction des chauffages D) Un mode éco imposé sans désactivation.";

test("sans annale ni indice de format : rien n'est inventé, aucun appel au modèle, la préparation continue", async () => {
  const id = await newCourse();
  await addSource(id, "course_pdf", "Séance 1", "Le leadership transformationnel s'oppose au leadership transactionnel. La motivation intrinsèque diminue avec les récompenses.");
  const { detectFormat } = await import("../lib/format");
  const { resolveExamFormat } = await import("../lib/exam-format");
  await inCourse(id, () => detectFormat());
  assert.equal(prompts.length, 0, "aucun appel au modèle sans indice");
  const f = await inCourse(id, () => resolveExamFormat());
  assert.equal(f.basis, "unknown");
});

test("les indices du corpus (slides) donnent un format « infos de cours », preuves citées", async () => {
  const id = await newCourse();
  await addSource(id, "course_pdf", "Vérifier et entreprendre", SLIDES);
  reply = { exam_kind: "qcm", question_count: null, open_count: null, duration_min: null, format_summary: "QCM, une seule réponse correcte", evidence: ["Chaque partie se termine par une question type QCM", "Une seule réponse correcte"], examples: ["Laquelle est un nudge ?"] };
  const { detectFormat } = await import("../lib/format");
  const { resolveExamFormat } = await import("../lib/exam-format");
  await inCourse(id, () => detectFormat());
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /question type QCM/, "le passage indice est montré au modèle");
  const f = await inCourse(id, () => resolveExamFormat());
  assert.equal(f.basis, "course_info");
  assert.equal(f.kind, "qcm");
  assert.deepEqual(f.evidence, ["Chaque partie se termine par une question type QCM", "Une seule réponse correcte"]);
});

test("des questions d'exemple officielles passent devant les indices du corpus", async () => {
  const id = await newCourse();
  await addSource(id, "course_pdf", "Vérifier et entreprendre", SLIDES);
  await addSource(id, "sample_questions", "Questions modèles", "Question 1. Une seule réponse correcte. Selon Vosoughi (2018), les fausses nouvelles se propagent : A) moins vite B) six fois plus vite C) aussi vite D) deux fois moins vite.");
  reply = { exam_kind: "qcm", question_count: 20, open_count: 0, duration_min: 45, format_summary: "QCM de 20 questions", evidence: ["Une seule réponse correcte"], examples: [] };
  const { detectFormat } = await import("../lib/format");
  const { resolveExamFormat } = await import("../lib/exam-format");
  await inCourse(id, () => detectFormat());
  assert.match(prompts[0], /Vosoughi/);
  const f = await inCourse(id, () => resolveExamFormat());
  assert.equal(f.basis, "sample_questions");
  assert.equal(f.questionCount, 20);
  assert.equal(f.durationMin, 45);
});

test("une affirmation du modèle sans citation retrouvée dans les sources vaut « inconnu »", async () => {
  const id = await newCourse();
  await addSource(id, "course_pdf", "Vérifier et entreprendre", SLIDES);
  reply = { exam_kind: "essay", question_count: 1, open_count: null, duration_min: 90, format_summary: "Essai de 90 minutes", evidence: ["L'examen est un essai de 90 minutes"], examples: [] };
  const { detectFormat } = await import("../lib/format");
  const { resolveExamFormat } = await import("../lib/exam-format");
  await inCourse(id, () => detectFormat());
  assert.equal((await inCourse(id, () => resolveExamFormat())).basis, "unknown");
});
