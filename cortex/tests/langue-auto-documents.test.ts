/**
 * LANGUE D'UN COURS CRÉÉ SANS LANGUE, RÈGLE DE DOCUMENTS DES ANNALES (audit i18n du 16/11/2026, #8, #10).
 * - Un cours créé sans langue (connecteur create_course, formulaire laissé sur « détecter ») était
 *   en français : sans annale, l'examen sortait en français. Sa langue est maintenant celle des
 *   annales, sinon celle de ses supports, sinon l'anglais ; une fois détectée, elle est gardée.
 * - La règle de documents écrite par la garde vient de la déclaration, sinon de l'annale
 *   (détection du format) ; jamais inventée.
 * Cours et textes FICTIFS, aucun appel LLM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-langue-auto-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
async function newCourse(over: Record<string, unknown> = {}): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: `Cours langue ${++seq}`, ...over }, "owner");
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
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exercise", title, text);
  });
}

async function saveProfile(course: string, json: Record<string, unknown>): Promise<void> {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithCourse(course, async () => {
    await q.ensureTable("format_profile");
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify(json));
  });
}

async function resolve(course: string) {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  return runWithCourse(course, () => resolveExamFormat());
}

const GERMAN_NOTES = "Die Ableitung einer Funktion ist der Grenzwert des Differenzenquotienten. Wir zeigen, dass die Funktion stetig ist und dass sie in jedem Punkt eine Tangente hat. Das ist nicht trivial, aber es ist ein wichtiges Ergebnis für die Analysis und wird in der Vorlesung mit einem Beispiel bewiesen.";
const ENGLISH_FINAL = "Final exam. Answer all the questions. For each of the following statements, choose the correct answer. The gradient of the loss is computed with respect to the weights and the model is trained on the data.";
const ANNALES_PROFILE = {
  format_summary: "~12 SCQ + 2 open questions", duration_min: 120, total_points: 60, has_mcq: true, scq_vs_mcq_convention: "",
  question_types: [{ type: "scq", approx_count: 12, share_pct: 60 }, { type: "open", approx_count: 2, share_pct: 40 }],
  sections: [], topics_emphasis: [], basis: "annales",
};

test("un cours créé sans langue n'est plus en français par défaut : la langue reste à détecter", async () => {
  const { buildCourseRow } = await import("../lib/course-create");
  assert.equal(buildCourseRow({ name: "Sans langue" }, "owner").language, "");
  assert.equal(buildCourseRow({ name: "Langue auto", language: "auto" }, "owner").language, "");
  assert.equal(buildCourseRow({ name: "Langue dite", language: "IT" }, "owner").language, "it");
});

test("sans langue ni support : anglais, pas français", async () => {
  const id = await newCourse();
  assert.equal((await resolve(id)).language, "en");
  const { formatContextFor } = await import("../lib/exam-format");
  assert.equal(formatContextFor(id).language, "en");
});

test("sans langue : la langue des supports est détectée, puis gardée sur le cours", async () => {
  const id = await newCourse();
  await addSource(id, "lecture", "Vorlesung 1", GERMAN_NOTES);
  assert.equal((await resolve(id)).language, "de");
  const { getCourse, reloadCourses } = await import("../lib/courses");
  await reloadCourses();
  assert.equal(getCourse(id).language, "de", "la langue détectée est enregistrée sur le cours");
});

test("sans langue : la langue des annales passe avant celle des supports", async () => {
  const id = await newCourse();
  await addSource(id, "lecture", "Vorlesung 1", GERMAN_NOTES);
  await addSource(id, "final", "Final 2025", ENGLISH_FINAL);
  assert.equal((await resolve(id)).language, "en");
  const { getCourse, reloadCourses } = await import("../lib/courses");
  await reloadCourses();
  assert.equal(getCourse(id).language, "en", "la langue des annales est enregistrée sur le cours");
});

test("une langue déclarée n'est jamais remplacée par la détection", async () => {
  const id = await newCourse({ language: "fr" });
  await addSource(id, "lecture", "Vorlesung 1", GERMAN_NOTES);
  assert.equal((await resolve(id)).language, "fr");
  const { getCourse } = await import("../lib/courses");
  assert.equal(getCourse(id).language, "fr");
});

test("règle de documents : celle de l'annale, sauf déclaration ; rien si aucune ne la dit", async () => {
  const { formatContextFor } = await import("../lib/exam-format");
  const fromAnnale = await newCourse({ language: "en" });
  await addSource(fromAnnale, "final", "Final 2025", ENGLISH_FINAL);
  await saveProfile(fromAnnale, { ...ANNALES_PROFILE, documents: "notes" });
  await resolve(fromAnnale);
  assert.equal(formatContextFor(fromAnnale).documents, "notes");

  const declared = await newCourse({ language: "en", examFormat: { kind: "qcm", documents: "none" } });
  await addSource(declared, "final", "Final 2025", ENGLISH_FINAL);
  await saveProfile(declared, { ...ANNALES_PROFILE, documents: "notes" });
  await resolve(declared);
  assert.equal(formatContextFor(declared).documents, "none");

  const silent = await newCourse({ language: "en" });
  await addSource(silent, "final", "Final 2025", ENGLISH_FINAL);
  await saveProfile(silent, { ...ANNALES_PROFILE, documents: "" });
  await resolve(silent);
  assert.equal(formatContextFor(silent).documents, null);
});
