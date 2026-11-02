/**
 * RÉPONSE UNIQUE OU MULTIPLE (lib/exam-format) — banc HUM-285 du 02/11/2026 : 7 questions
 * sur 19 à réponses multiples, alors que le vrai examen est à réponse unique (« une seule
 * réponse correcte », slides de Bendahan). Le format déclaré « QCM » ne disait pas laquelle.
 * Verrouillé ici : le mode se déclare (fiche du cours, connecteur), vaut « réponse unique »
 * quand rien ne dit le contraire, et, avec des annales, c'est leur forme qui fait foi.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ExamFormat } from "../lib/exam-format";

// Le dossier de données AVANT tout chargement du moteur : imports dynamiques seulement.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-answer-mode-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
async function newCourse(over: Record<string, unknown> = {}): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: `Cours réponses ${++seq}`, ...over }, "owner");
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

async function resolve(course: string): Promise<ExamFormat> {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  return runWithCourse(course, () => resolveExamFormat());
}

const profile = (types: { type: string; approx_count: number }[]) => ({
  format_summary: "QCM", duration_min: 60, total_points: 20, has_mcq: true, scq_vs_mcq_convention: "",
  question_types: types.map((t) => ({ ...t, share_pct: 50, points_each: 1, note: "" })), sections: [], topics_emphasis: [],
});

test("un QCM déclaré sans mode de réponse est à réponse unique, et le résumé le dit", async () => {
  const id = await newCourse({ examFormat: { kind: "qcm", questionCount: 20 } });
  const f = await resolve(id);
  assert.equal(f.answerMode, "single");
  assert.match(f.summary, /réponse unique/);
});

test("le mode déclaré (fiche : answerMode, connecteur : answer_mode) est stocké et appliqué", async () => {
  const many = await newCourse({ examFormat: { kind: "qcm", answerMode: "multiple" } });
  const { getCourse } = await import("../lib/courses");
  assert.equal(getCourse(many).examFormat?.answerMode, "multiple");
  assert.equal((await resolve(many)).answerMode, "multiple");
  const mixed = await newCourse({ examFormat: { kind: "mixed", answer_mode: "mixed" } });
  assert.equal((await resolve(mixed)).answerMode, "mixed");
});

test("un mode de réponse inconnu est refusé ; un format sans choix n'a pas de mode", async () => {
  const { parseDeclaredFormat, InvalidFormatError } = await import("../lib/exam-format");
  assert.throws(() => parseDeclaredFormat({ kind: "qcm", answerMode: "plusieurs" }), InvalidFormatError);
  const essay = await newCourse({ examFormat: { kind: "essay", questionCount: 1 } });
  assert.equal((await resolve(essay)).answerMode, null);
});

test("avec des annales, leur forme fait foi : QCM à réponse unique, à réponses multiples, ou les deux", async () => {
  const single = await newCourse({ examFormat: { kind: "qcm", answerMode: "multiple" } });
  await addSource(single, "final", "Final 2024", "Examen final. Pour chaque question, une seule réponse est correcte.");
  await saveProfile(single, profile([{ type: "scq", approx_count: 20 }]));
  const s = await resolve(single);
  assert.equal(s.basis, "annales");
  assert.equal(s.answerMode, "single", "la déclaration ne contredit pas les annales");

  const multi = await newCourse();
  await addSource(multi, "final", "Final 2023", "Examen final. Cochez toutes les réponses correctes.");
  await saveProfile(multi, profile([{ type: "mcq", approx_count: 16 }]));
  assert.equal((await resolve(multi)).answerMode, "multiple");

  const both = await newCourse();
  await addSource(both, "midterm", "Midterm 2023", "Examen intermédiaire. Questions à choix unique puis à choix multiple.");
  await saveProfile(both, profile([{ type: "scq", approx_count: 10 }, { type: "mcq", approx_count: 6 }, { type: "open", approx_count: 2 }]));
  assert.equal((await resolve(both)).answerMode, "mixed");
});

test("sans annale ni déclaration : le mode lu dans les sources, sinon réponse unique", async () => {
  const info = await newCourse();
  await saveProfile(info, { ...profile([{ type: "mcq", approx_count: 20 }]), basis: "course_info", exam_kind: "qcm", answer_mode: "multiple", evidence: ["Une ou plusieurs réponses sont correctes."] });
  assert.equal((await resolve(info)).answerMode, "multiple");

  const silent = await newCourse();
  await saveProfile(silent, { ...profile([{ type: "scq", approx_count: 20 }]), basis: "course_info", exam_kind: "qcm", evidence: ["L'examen est un QCM."] });
  assert.equal((await resolve(silent)).answerMode, "single");

  // Une déclaration sans mode laisse parler les sources ; une déclaration avec mode l'emporte.
  const declared = await newCourse({ examFormat: { kind: "qcm" } });
  await saveProfile(declared, { ...profile([]), basis: "course_info", exam_kind: "qcm", answer_mode: "multiple", evidence: ["Plusieurs réponses possibles."] });
  assert.equal((await resolve(declared)).answerMode, "multiple");
  const forced = await newCourse({ examFormat: { kind: "qcm", answerMode: "single" } });
  await saveProfile(forced, { ...profile([]), basis: "course_info", exam_kind: "qcm", answer_mode: "multiple", evidence: ["Plusieurs réponses possibles."] });
  assert.equal((await resolve(forced)).answerMode, "single");
});
