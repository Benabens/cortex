/**
 * FORMAT D'EXAMEN ET AIGUILLAGE UNIQUE (lib/exam-format).
 *
 * Le cas qui a motivé ce module (HUM-285, 27/10/2026) : un cours SHS sans
 * annale, dont le vrai examen est un QCM d'une vingtaine de questions, recevait
 * UN exercice d'étude de cas à 20 sous-questions. Ce qui est verrouillé ici :
 * l'ordre de confiance des sources du format (annales > format déclaré >
 * questions d'exemple officielles > infos de cours > inconnu), l'aiguillage
 * vers le bon générateur, le refus explicite quand le format est inconnu, et
 * la langue de l'examen (celle du cours, sauf annales contraires).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ExamFormat, MockExamPlan, MockExamRequest } from "../lib/exam-format";

// Le dossier de données AVANT tout chargement du moteur (lib/courses le lit à l'import) :
// d'où les imports dynamiques, jamais statiques, dans ce fichier.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-format-"));
process.env.CORTEX_DATA_DIR = tmp;

let planMockExam: (f: ExamFormat, r: MockExamRequest) => MockExamPlan;

before(async () => {
  delete process.env.CORTEX_USER;
  ({ planMockExam } = await import("../lib/exam-format"));
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fmt(over: Partial<ExamFormat>): ExamFormat {
  return { basis: "declared", kind: "qcm", questionCount: null, openCount: null, durationMin: null, language: "fr", discipline: "stem", summary: "", evidence: [], ...over };
}

// ───────────────────────────── aiguillage (pur) ─────────────────────────────

test("un QCM déclaré de 20 questions part au générateur QCM avec 20 questions et aucune ouverte", () => {
  const plan = planMockExam(fmt({ kind: "qcm", questionCount: 20 }), {});
  assert.deepEqual(plan, { generator: "qcm", qcmCount: 20, openCount: 0 });
});

test("le nombre demandé l'emporte sur le format ; le focus ne change pas le générateur", () => {
  const plan = planMockExam(fmt({ kind: "qcm", questionCount: 20 }), { count: 6, focus: "QCM ~20 questions moitié Bendahan / moitié Cavallaro" });
  assert.deepEqual(plan, { generator: "qcm", qcmCount: 6, openCount: 0 });
});

test("un examen mixte garde ses questions ouvertes", () => {
  assert.deepEqual(planMockExam(fmt({ basis: "annales", kind: "mixed", questionCount: 16, openCount: 3 }), {}), { generator: "qcm", qcmCount: 16, openCount: 3 });
  assert.deepEqual(planMockExam(fmt({ kind: "mixed", questionCount: 10 }), {}), { generator: "qcm", qcmCount: 10, openCount: 2 });
});

test("un QCM sans nombre connu prend 20 questions, borné à 40", () => {
  assert.deepEqual(planMockExam(fmt({ kind: "qcm" }), {}), { generator: "qcm", qcmCount: 20, openCount: 0 });
  assert.deepEqual(planMockExam(fmt({ kind: "qcm", questionCount: 300 }), {}), { generator: "qcm", qcmCount: 40, openCount: 0 });
});

test("des exercices gardent le nombre du plan du cours quand rien n'est demandé", () => {
  assert.deepEqual(planMockExam(fmt({ basis: "annales", kind: "exercises" }), {}), { generator: "exercises", style: "problems", exerciseCount: null });
  assert.deepEqual(planMockExam(fmt({ kind: "exercises", questionCount: 5 }), { count: 3 }), { generator: "exercises", style: "problems", exerciseCount: 3 });
});

test("un essai ou un oral passent par les exercices, au style de l'épreuve", () => {
  assert.deepEqual(planMockExam(fmt({ kind: "essay", questionCount: 1 }), {}), { generator: "exercises", style: "essay", exerciseCount: 1 });
  assert.deepEqual(planMockExam(fmt({ kind: "essay" }), {}), { generator: "exercises", style: "essay", exerciseCount: 2 });
  assert.deepEqual(planMockExam(fmt({ kind: "oral" }), {}), { generator: "exercises", style: "oral", exerciseCount: 3 });
});

test("un format inconnu ne génère rien et dit quoi déclarer", () => {
  const plan = planMockExam(fmt({ basis: "unknown", kind: null }), { focus: "QCM ~20 questions" });
  assert.equal(plan.generator, "none");
  assert.ok(plan.generator === "none" && /format/i.test(plan.reason) && /QCM/.test(plan.reason) && /dur[ée]e/i.test(plan.reason));
});

// ─────────────────────── résolution (base SQLite réelle) ───────────────────────

let seq = 0;
/** Cours neuf du compte courant (owner), avec un format déclaré facultatif. */
async function newCourse(over: Record<string, unknown> = {}): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: `Cours format ${++seq}`, ...over }, "owner");
  await insertCourse(row);
  await reloadCourses();
  return row.id;
}

/** Ajoute une source et son texte au corpus du cours. */
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

const ENGLISH_FINAL = "Final exam. Answer all the questions. For each of the following statements, choose the correct answer. The gradient of the loss is computed with respect to the weights and the model is trained on the data.";
const ANNALES_PROFILE = {
  format_summary: "~16 SCQ/MCQ + 3 open questions", duration_min: 180, total_points: 116, has_mcq: true, scq_vs_mcq_convention: "SCQ",
  question_types: [{ type: "scq", approx_count: 10, share_pct: 30 }, { type: "mcq", approx_count: 6, share_pct: 25 }, { type: "open", approx_count: 3, share_pct: 45 }],
  sections: [], topics_emphasis: [],
};

test("cours neuf sans annale ni déclaration : format inconnu, langue du cours", async () => {
  const id = await newCourse({ language: "de" });
  const f = await resolve(id);
  assert.equal(f.basis, "unknown");
  assert.equal(f.kind, null);
  assert.equal(f.language, "de");
  assert.equal(planMockExam(f, {}).generator, "none");
});

test("un format déclaré à la création est stocké sur le cours et pilote l'examen", async () => {
  const id = await newCourse({ examFormat: { kind: "qcm", questionCount: 20, durationMin: 45 } });
  const { getCourse } = await import("../lib/courses");
  assert.deepEqual(getCourse(id).examFormat, { kind: "qcm", questionCount: 20, durationMin: 45, language: null });
  const f = await resolve(id);
  assert.equal(f.basis, "declared");
  assert.equal(f.kind, "qcm");
  assert.equal(f.questionCount, 20);
  assert.equal(f.durationMin, 45);
  assert.equal(f.language, "fr", "sans langue déclarée : la langue du cours");
  assert.deepEqual(planMockExam(f, {}), { generator: "qcm", qcmCount: 20, openCount: 0 });
});

test("un format déclaré invalide est refusé avec un message clair", async () => {
  const { buildCourseRow, InvalidCourseError } = await import("../lib/course-create");
  assert.throws(() => buildCourseRow({ name: "Cours bancal", examFormat: { kind: "dissertation" } }, "owner"), InvalidCourseError);
  assert.throws(() => buildCourseRow({ name: "Cours bancal", examFormat: { kind: "qcm", questionCount: 0 } }, "owner"), /questions/);
  assert.throws(() => buildCourseRow({ name: "Cours bancal", examFormat: { kind: "qcm", language: "klingon" } }, "owner"), /[Ll]angue/);
});

test("des annales au format détecté l'emportent sur la déclaration ; leur langue l'emporte sur celle du cours", async () => {
  const id = await newCourse({ language: "fr", examFormat: { kind: "essay", questionCount: 1 } });
  await addSource(id, "final", "Final 2024", ENGLISH_FINAL);
  await saveProfile(id, ANNALES_PROFILE);
  const f = await resolve(id);
  assert.equal(f.basis, "annales");
  assert.equal(f.kind, "mixed");
  assert.equal(f.questionCount, 16);
  assert.equal(f.openCount, 3);
  assert.equal(f.language, "en");
});

test("des annales dont le format n'est pas encore détecté gardent le comportement historique (exercices)", async () => {
  const id = await newCourse();
  await addSource(id, "final", "Final 2023", "Examen final. Exercice 1 : on considère la fonction f définie sur les réels et on étudie sa dérivée.");
  const f = await resolve(id);
  assert.equal(f.basis, "annales");
  assert.equal(f.kind, "exercises");
  assert.equal(f.language, "fr");
});

test("…sauf si l'étudiant a déclaré le format : sa déclaration vaut mieux qu'un défaut", async () => {
  const id = await newCourse({ examFormat: { kind: "qcm", questionCount: 12 } });
  await addSource(id, "midterm", "Midterm 2023", "Examen intermédiaire. Pour chaque question, une seule réponse est correcte.");
  const f = await resolve(id);
  assert.equal(f.basis, "declared");
  assert.equal(f.kind, "qcm");
});

test("sans annale : questions d'exemple officielles > infos de cours, et la déclaration passe devant les deux", async () => {
  const samples = await newCourse();
  await saveProfile(samples, { ...ANNALES_PROFILE, basis: "sample_questions", exam_kind: "qcm", question_count: 20, evidence: ["« Une seule réponse correcte »"] });
  const s = await resolve(samples);
  assert.equal(s.basis, "sample_questions");
  assert.equal(s.kind, "qcm");
  assert.equal(s.questionCount, 20);
  assert.deepEqual(s.evidence, ["« Une seule réponse correcte »"]);

  const info = await newCourse();
  await saveProfile(info, { ...ANNALES_PROFILE, has_mcq: false, basis: "course_info", exam_kind: "essay", question_count: 1, duration_min: 45, evidence: ["Essai de 45 minutes"] });
  const i = await resolve(info);
  assert.equal(i.basis, "course_info");
  assert.equal(i.kind, "essay");
  assert.equal(i.durationMin, 45);

  const declared = await newCourse({ examFormat: { kind: "oral" } });
  await saveProfile(declared, { ...ANNALES_PROFILE, basis: "sample_questions", exam_kind: "qcm", evidence: ["x"] });
  assert.equal((await resolve(declared)).kind, "oral");
});

test("une détection sans annale qui n'a rien trouvé laisse le format inconnu", async () => {
  const id = await newCourse();
  await saveProfile(id, { basis: "unknown", exam_kind: null, evidence: [], format_summary: "", has_mcq: false, question_types: [] });
  assert.equal((await resolve(id)).basis, "unknown");
});

test("CS-202 garde son format historique (exercices de calcul et de trace)", async () => {
  const f = await resolve("cs-202");
  assert.equal(f.basis, "annales");
  assert.equal(f.kind, "exercises");
});

// ─────────────────────── lancement (app et connecteur) ───────────────────────

test("lancer un examen blanc sans format connu est refusé (409) avec ce qu'il faut déclarer, sans créer de job", async () => {
  const id = await newCourse();
  await addSource(id, "course_pdf", "Séance 1", "Le leadership transformationnel motive par le sens.");
  const { runWithCourse } = await import("../db/client");
  const { startGenerationJob } = await import("../lib/generation");
  const { q } = await import("../db/q");
  const r = await runWithCourse(id, () => startGenerationJob("exam"));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.status === 409 && /Format d'examen inconnu/.test(r.error), JSON.stringify(r));
  const jobs = await runWithCourse(id, async () => { await q.ensureTable("jobs"); return q.get<{ n: number }>(`SELECT count(*) n FROM jobs`); });
  assert.equal(Number(jobs?.n), 0);
});
