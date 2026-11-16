/**
 * GABARIT DE L'EPFL DANS LA LANGUE DE L'EXAMEN (audit i18n du 16/11/2026, #5-#7, #10, #11, #19, #20).
 * Un cours de l'EPFL autre que cs-202 garde la mise en page de l'EPFL (logo, SCIPER, QR, rouge),
 * mais ses libellés fixes suivent la langue de l'examen : un QCM en français ou en allemand
 * gardait « Lecturer », « Duration », « First part », « Open question », « Output: », un corrigé
 * anglais disait « idée fausse : » et « Corrigé », le pied « Examen final ». La consigne inventée
 * « cheat sheet / no electronic device » n'est plus écrite : seule une règle de documents déclarée
 * l'est. cs-202 reste byte-identique (tests/tex-guard). Cours FICTIFS.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gabarit-epfl-langue-"));
process.env.CORTEX_DATA_DIR = tmp;

type Lang = "en" | "fr" | "de";
const ids: Record<Lang | "enNotes" | "frNoDuration", string> = { en: "", fr: "", de: "", enNotes: "", frNoDuration: "" };

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const rows = {
    en: buildCourseRow({ name: "Fictional Circuits", code: "FIC-201", university: "EPFL", teachers: "Prof. A. Fictif", language: "en" }, "owner"),
    fr: buildCourseRow({ name: "Analyse inventée", code: "FIC-202", university: "EPFL", teachers: "Prof. B. Exemple", language: "fr", examFormat: { kind: "exercises", durationMin: 120 } }, "owner"),
    de: buildCourseRow({ name: "Erfundene Logik", code: "FIC-203", university: "EPFL", teachers: "Prof. C. Muster", language: "de", examFormat: { kind: "exercises", durationMin: 90 } }, "owner"),
    frNoDuration: buildCourseRow({ name: "Analyse sans horaire", code: "FIC-205", university: "EPFL", language: "fr" }, "owner"),
    enNotes: buildCourseRow({ name: "Fictional Notes", code: "FIC-204", university: "EPFL", language: "en", examFormat: { kind: "qcm", documents: "notes" } }, "owner"),
  };
  for (const r of Object.values(rows)) await insertCourse(r);
  await reloadCourses();
  for (const k of Object.keys(rows) as (keyof typeof rows)[]) ids[k] = rows[k].id;
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Ce que le rendu écrit APRÈS le préambule commun : celui-ci, écrit pour cs-202 et inchangé, porte
 * l'en-tête et la marge de cs-202, que le rendu d'un autre cours réécrit ensuite.
 */
function own(tex: string): string {
  const latex = path.join(process.cwd(), "latex");
  const figures = path.join(latex, "figures.tex");
  const common = fs.readFileSync(path.join(latex, "preamble.tex"), "utf8") + (fs.existsSync(figures) ? "\n" + fs.readFileSync(figures, "utf8") : "");
  assert.ok(tex.startsWith(common), "le .tex commence par le préambule commun");
  return tex.slice(common.length);
}

async function inCourse<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(id, async () => fn());
}

async function qcm(k: keyof typeof ids, key = true): Promise<string> {
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { QCM_DATA, DATE } = await import("./helpers/gabarits");
  return own(await inCourse(ids[k], () => renderQcmExamTex(QCM_DATA, DATE, key)));
}

async function blocks(k: Lang): Promise<string> {
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const { BLOCKS, DATE } = await import("./helpers/gabarits");
  return own(await inCourse(ids[k], () => renderBlocksTex(BLOCKS, DATE, true)));
}

async function written(k: Lang): Promise<string> {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  return own(await inCourse(ids[k], () => renderExamTex(WRITTEN_SPEC as never, DATE, true)));
}

const ENGLISH_CHROME = /Lecturer|Duration|\{Instructions\}|First part|Second part|Open question|Tick the box|Answer directly|Do NOT write|Output:|Model answer:|Grading:/;

test("QCM de l'EPFL en anglais : plus de « idée fausse : », « Solution : » ni « Examen final »", async () => {
  const tex = await qcm("en");
  assert.doesNotMatch(tex, /idée fausse|Solution :|Examen final|Anonymisation :/);
  assert.match(tex, /misconception: off by one/);
  assert.match(tex, /\\textbf\{Solution:\} 2 \+ 3 = 5\./);
  assert.match(tex, /FIC--201, Final Exam/);
  assert.match(tex, /Lecturer: Prof\. A\. Fictif/, "la garde anglaise de l'EPFL est inchangée");
});

test("QCM de l'EPFL en français : garde, parties, corrigé et marge en français", async () => {
  const tex = await qcm("fr");
  assert.doesNotMatch(tex, ENGLISH_CHROME);
  assert.match(tex, /Responsable : Prof\. B\. Exemple/);
  assert.match(tex, /16 novembre 2026\\quad Durée : /);
  assert.match(tex, /Partie 1 \\quad-- Questions à choix multiple/);
  assert.match(tex, /Question ouverte 1/);
  assert.match(tex, /idée fausse -- off by one/);
  assert.match(tex, /NE RIEN ÉCRIRE ICI/);
  assert.match(tex, /FIC--202, Examen final/);
  assert.match(tex, /\\epfllogo\[26\]/, "la mise en page de l'EPFL reste");
});

test("QCM de l'EPFL en allemand : tout en allemand", async () => {
  const tex = await qcm("de");
  assert.doesNotMatch(tex, ENGLISH_CHROME);
  assert.doesNotMatch(tex, /idée fausse|Examen final|Corrigé/);
  assert.match(tex, /Lehrperson: Prof\. C\. Muster/);
  assert.match(tex, /Dauer: /);
  assert.match(tex, /Teil 2 \\quad-- Offene Fragen/);
  assert.match(tex, /Fehlvorstellung -- off by one/);
  assert.match(tex, /FIC--203, Abschlussprüfung/);
});

test("QCM de l'EPFL en français sans durée connue : aucune durée écrite, ni inventée", async () => {
  const tex = await qcm("frNoDuration");
  assert.doesNotMatch(tex, /Durée|minutes|\d h\b/);
  assert.match(tex, /16 novembre 2026\n/);
});

test("aucune consigne de documents inventée ; une règle déclarée est écrite", async () => {
  for (const k of ["en", "fr", "de"] as const) {
    assert.doesNotMatch(await qcm(k, false), /cheat sheet|electronic device/);
    assert.doesNotMatch(await blocks(k), /cheat sheet|electronic device/);
  }
  assert.match(await qcm("enNotes", false), /\\item Personal notes are allowed\./);
});

test("questions composées de l'EPFL en français et en allemand : libellés traduits", async () => {
  const fr = await blocks("fr");
  assert.doesNotMatch(fr, ENGLISH_CHROME);
  assert.match(fr, /Sortie :/);
  assert.match(fr, /Réponse type :/);
  assert.match(fr, /Barème :/);
  const de = await blocks("de");
  assert.doesNotMatch(de, ENGLISH_CHROME);
  assert.match(de, /Musterlösung:/);
  const en = await blocks("en");
  assert.match(en, /Model answer:/, "l'anglais garde ses libellés");
});

test("examen écrit de l'EPFL hors cs-202 : titres du corrigé et pied dans la langue de l'examen", async () => {
  const en = await written("en");
  assert.doesNotMatch(en, /Corrigé|Examen final|Question 1 : |Anonymisation :/);
  assert.match(en, /\\textbf\{Solutions\}/);
  assert.match(en, /FIC--201, Final Exam/);
  const de = await written("de");
  assert.doesNotMatch(de, /Corrigé|Examen final|Do NOT write/);
  assert.match(de, /\\textbf\{Lösungen\}/);
  assert.match(de, /Aufgabe 1 \\quad-- Toy recurrence/);
  assert.match(de, /Abschlussprüfung/);
  const fr = await written("fr");
  assert.match(fr, /\\textbf\{Corrigé\}/);
  assert.match(fr, /NE RIEN ÉCRIRE ICI/);
});

test("exercice ciblé hors cs-202 : titre et corrigé dans la langue de l'examen", async () => {
  const { renderExerciseLatex } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  const de = own(await inCourse(ids.de, () => renderExerciseLatex(WRITTEN_SPEC.questions[0] as never, DATE, true)));
  assert.doesNotMatch(de, /Exercise|\{Solution\}/);
  assert.match(de, /Aufgabe \\quad-- Toy recurrence \\hfill \[30 Punkte\]/);
  assert.match(de, /\\textbf\{Lösung\}/);
});

test("PDF de l'EPFL en allemand compilés : marge et libellés allemands sur les pages (sauté sans tectonic ni pdftotext)", async (t) => {
  const { buildExamArtifact, texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable() || spawnSync("pdftotext", ["-v"]).error) return t.skip("tectonic/pdflatex ou pdftotext absent");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const { buildBlocksArtifact } = await import("../lib/blocks-latex");
  const { examsDir } = await import("../lib/paths");
  const { WRITTEN_SPEC, QCM_DATA, BLOCKS, DATE } = await import("./helpers/gabarits");
  await inCourse(ids.de, async () => {
    assert.equal((await buildExamArtifact(WRITTEN_SPEC as never, 911, DATE)).kind, "pdf");
    const qcm = await buildQcmArtifact(912, QCM_DATA, DATE);
    assert.equal(qcm.file, "qcm-912.pdf", qcm.texError);
    assert.equal(qcm.texWarning, undefined);
    assert.equal((await buildBlocksArtifact(913, BLOCKS, DATE)).file, "blocks-913.pdf");
    for (const base of ["exam-911", "qcm-912", "blocks-913"]) {
      for (const name of [base, `${base}-corrige`]) {
        const text = execFileSync("pdftotext", [path.join(examsDir(), `${name}.pdf`), "-"]).toString();
        assert.match(text, /BITTE LEER LASSEN/, name);
        assert.doesNotMatch(text, /Do NOT write|Lecturer|Duration|Examen final|Corrigé|cheat sheet/, name);
      }
    }
  });
});
