/**
 * PROFIL GÉNÉRIQUE SELON LA DISCIPLINE ET LA LANGUE (lib/profiles/generic).
 *
 * Avant : un seul archétype « exercice d'examen » orienté final STEM (artefact
 * concret, nombres non ronds, ~180 pts), donc UN slot qui absorbait tout
 * l'examen, et des consignes « 100 % ANGLAIS » quelle que soit la langue du
 * cours. Verrouillé ici : la langue de l'examen (celle du cours, sauf annales
 * contraires), des archétypes propres aux matières non-STEM (argumentation
 * avec grille, critique de texte, compréhension fine), et plusieurs sujets
 * couvrant des notions différentes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-generic-profile-"));
process.env.CORTEX_DATA_DIR = tmp;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
async function newCourse(over: Record<string, unknown> = {}): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: `Cours profil ${++seq}`, ...over }, "owner");
  await insertCourse(row);
  await reloadCourses();
  return row.id;
}

async function seed(course: string, sources: [type: string, title: string, text: string][], topics: string[] = []): Promise<void> {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithCourse(course, async () => {
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    for (const [type, title, text] of sources) {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, `${type}/${title}`, null, 1);
      await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, type, title, text);
    }
    for (const [i, label] of topics.entries()) await q.run(`INSERT INTO topics (label, exam_weight, exam_count) VALUES (?,?,?)`, label, 10 - i, 1);
  });
}

/** Résout le format (comme le worker avant de générer), puis rend le profil du cours. */
async function profileOf(course: string) {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  const { getProfile } = await import("../lib/course-profile");
  return runWithCourse(course, async () => {
    await resolveExamFormat();
    const p = getProfile(course);
    return { p, slots: await p.buildBlueprint() };
  });
}

const PROSE = "Le nudge est une intervention qui modifie l'architecture du choix sans interdire aucune option ni changer significativement les incitations économiques. " +
  "Thaler et Sunstein parlent de paternalisme libéral. Les biais cognitifs, comme l'ancrage ou le cadrage, expliquent pourquoi l'option par défaut est si puissante.";
const MATHS = "Soit f(x) = 3x^2 + 2x - 5. On calcule f'(x) = 6x + 2 = 0 donc x = -1/3. La matrice A = [[2, 1], [1, 3]] a pour valeurs propres λ = (5 ± √5)/2. " +
  "∑_{k=1}^{n} k = n(n+1)/2 et ∫_0^1 x^2 dx = 1/3, σ^2 = E[X^2] - E[X]^2 = 0.25.";

test("discipline : le code du cours tranche, sinon la densité mathématique du corpus", async () => {
  const { inferDiscipline } = await import("../lib/exam-format");
  assert.equal(inferDiscipline({ code: "HUM-285", sample: MATHS }), "humanities");
  assert.equal(inferDiscipline({ code: "MATH-111", sample: PROSE }), "stem");
  assert.equal(inferDiscipline({ code: "", sample: MATHS.repeat(3) }), "stem");
  assert.equal(inferDiscipline({ code: "", sample: PROSE.repeat(3) }), "humanities");
  assert.equal(inferDiscipline({ code: "", sample: "" }), "stem", "sans rien pour trancher : comportement historique");
});

test("cours en français sans annale : les consignes sont en français, plus jamais « 100% ANGLAIS »", async () => {
  const id = await newCourse({ code: "HUM-285", language: "fr", examFormat: { kind: "essay", questionCount: 2 } });
  await seed(id, [["course_pdf", "Nudges", PROSE]]);
  const { p } = await profileOf(id);
  assert.match(p.directivesBlock(), /LANGUE : 100% FRANÇAIS/);
  assert.doesNotMatch(p.directivesBlock(), /ANGLAIS/);
  assert.match(p.promptIntroBatch(2).join("\n"), /EN FRANÇAIS/);
  assert.doesNotMatch(p.promptIntroBatch(2).join("\n"), /EN ANGLAIS/);
});

test("des annales en anglais gardent des consignes en anglais, à l'identique", async () => {
  const id = await newCourse({ code: "MATH-999", language: "fr" });
  await seed(id, [["final", "Final 2024", "Final exam. Answer all the questions. For each of the following statements, choose the correct answer. The gradient of the loss is computed with respect to the weights and the model is trained on the data. " + MATHS]]);
  const { p } = await profileOf(id);
  assert.match(p.directivesBlock(), /  - LANGUE : 100% ANGLAIS — titres ET corps de tous les énoncés et corrigés en anglais\./);
  assert.match(p.directivesBlock(), /nombres NON RONDS/);
});

test("matière SHS en essai : argumentation avec grille et critique de texte, plusieurs sujets, rien de STEM", async () => {
  const id = await newCourse({ code: "HUM-286", language: "fr", examFormat: { kind: "essay", questionCount: 2 } });
  await seed(id, [["course_pdf", "Nudges", PROSE]], ["Nudges et architecture du choix", "Biais cognitifs", "Leadership transformationnel", "Désinformation générative"]);
  const { p, slots } = await profileOf(id);
  assert.ok(slots.length >= 2, `plusieurs sujets (${slots.length})`);
  const briefs = slots.map((s) => s.brief).join("\n");
  assert.match(briefs, /argument/i);
  assert.match(briefs, /grille/i);
  assert.doesNotMatch(briefs + p.directivesBlock(), /NON RONDS|artefact concret/i);
  assert.ok(p.archetypes.some((a) => /critique/.test(a.id)), p.archetypes.map((a) => a.id).join(", "));
});

test("cours générique à exercices : jamais un slot unique, chaque exercice sur une notion différente", async () => {
  const id = await newCourse({ code: "PHYS-777", language: "fr", examFormat: { kind: "exercises" } });
  await seed(id, [["course_pdf", "Mécanique", MATHS]], ["Cinématique du point", "Oscillateur harmonique", "Travail et énergie", "Moment cinétique"]);
  const { slots } = await profileOf(id);
  assert.ok(slots.length >= 3, `plusieurs exercices (${slots.length})`);
  const themes = slots.map((s) => /THÈME : « ([^»]+) »/.exec(s.brief)?.[1]);
  assert.ok(themes.every(Boolean), slots.map((s) => s.brief).join("\n"));
  assert.equal(new Set(themes).size, themes.length, `notions distinctes : ${themes.join(" | ")}`);
});
