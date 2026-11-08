/**
 * Cours synthétiques du banc (lib/bench/synth) : déterminisme (même graine -> même cours),
 * cas limites de pages (cours minuscule / cours de centaines de pages), bilingue, et les
 * quatre supports écrits sur disque (md, pdf, docx, scan). Le pdf et le scan dépendent de
 * tectonic : sautés si le binaire n'est pas dans le PATH.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { estimatePages, synthCourse, writeCourseFiles } from "../lib/bench/synth";

function which(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const hasTectonic = which("tectonic");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-synth-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("même graine : cours strictement identique ; graine différente : notions différentes", () => {
  const spec = { seed: 42, chapters: 2, conceptsPerChapter: 3, language: "fr" as const };
  const a = synthCourse(spec);
  const b = synthCourse({ ...spec });
  assert.deepEqual(a, b);

  const c = synthCourse({ ...spec, seed: 43 });
  const namesA = a.facts.filter((f) => f.kind === "definition").map((f) => f.concept);
  const namesC = c.facts.filter((f) => f.kind === "definition").map((f) => f.concept);
  assert.notDeepEqual(namesA, namesC);
});

test("estimatePages : cours de 3 pages (1x3) entre 2 et 5", () => {
  const course = synthCourse({ seed: 1, chapters: 1, conceptsPerChapter: 3, language: "fr" });
  const pages = estimatePages(course);
  assert.ok(pages >= 2 && pages <= 5, `pages = ${pages}`);
});

test("estimatePages : cours de centaines de pages (40x12x3), sans écrire de fichier", () => {
  const course = synthCourse({ seed: 1, chapters: 40, conceptsPerChapter: 12, examplesPerConcept: 3, language: "fr" });
  const pages = estimatePages(course);
  assert.ok(pages > 500, `pages = ${pages}`);
});

test("bilingue : langues alternées, facts non vides, statements verbatim, notions uniques", () => {
  const course = synthCourse({ seed: 7, chapters: 4, conceptsPerChapter: 2, language: "bilingual" });
  assert.deepEqual(course.chapters.map((c) => c.language), ["fr", "en", "fr", "en"]);
  assert.ok(course.facts.length > 0);

  for (const fact of course.facts) {
    const chapter = course.chapters.find((c) => c.seq === fact.chapter);
    assert.ok(chapter, `chapitre ${fact.chapter} introuvable`);
    assert.ok(chapter!.markdown.includes(fact.statement), `statement absent du markdown : ${fact.statement}`);
  }

  const names = course.facts.filter((f) => f.kind === "definition").map((f) => f.concept);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 4 * 2);
});

test("docx : mammoth extrait le texte d'une définition", async () => {
  const course = synthCourse({ seed: 11, chapters: 1, conceptsPerChapter: 2, language: "fr" });
  const dir = path.join(tmp, "docx");
  const [docxPath] = await writeCourseFiles(course, dir, "docx");

  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ path: docxPath });

  const def = course.facts.find((f) => f.kind === "definition");
  assert.ok(def);
  assert.ok(value.includes(def!.concept), "le nom de la notion n'apparaît pas dans le texte extrait");
  assert.ok(value.includes("Définition"), "le mot « Définition » n'apparaît pas dans le texte extrait");
});

test("pdf : pdftotext retrouve le nom d'une notion ; scan : quasi aucun texte, >= 1 page", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  const course = synthCourse({ seed: 23, chapters: 1, conceptsPerChapter: 2, language: "fr" });
  const def = course.facts.find((f) => f.kind === "definition");
  assert.ok(def);

  const pdfDir = path.join(tmp, "pdf");
  const [pdfPath] = await writeCourseFiles(course, pdfDir, "pdf");
  const pdfText = normalizePdfText(execFileSync("pdftotext", [pdfPath, "-"], { encoding: "utf8" }));
  assert.ok(pdfText.includes(def!.concept), "le nom de la notion n'apparaît pas dans le pdftotext du pdf texte");

  const scanDir = path.join(tmp, "scan");
  const [scanPath] = await writeCourseFiles(course, scanDir, "scan");
  const scanText = execFileSync("pdftotext", [scanPath, "-"], { encoding: "utf8" });
  const nonBlank = scanText.replace(/\s/g, "").length;
  assert.ok(nonBlank < 50, `${nonBlank} caractères non blancs extraits du scan (attendu < 50)`);

  const info = execFileSync("pdfinfo", [scanPath], { encoding: "utf8" });
  const pages = Number(/^Pages:\s*(\d+)/m.exec(info)?.[1] ?? 0);
  assert.ok(pages >= 1, `pdfinfo n'annonce pas de page sur le scan (${info})`);
});

/** Les césures (« -\n ») et la ligature « fi/fl » cassent une comparaison mot pour mot : on les recolle avant de chercher. */
function normalizePdfText(s: string): string {
  return s.replace(/-\n/g, "").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/\s+/g, " ");
}

test("pdf-chapters : un PDF par chapitre, comme les supports d'un cours en séances", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  const course = synthCourse({ seed: 12, chapters: 3, conceptsPerChapter: 1, language: "bilingual" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-synth-chap-"));
  try {
    const files = await writeCourseFiles(course, dir, "pdf-chapters");
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => path.basename(f).slice(0, 5)), ["ch01-", "ch02-", "ch03-"]);
    for (const [i, f] of files.entries()) {
      const text = execFileSync("pdftotext", [f, "-"], { encoding: "utf8" });
      const concept = course.facts.find((x) => x.chapter === i + 1)!.concept;
      assert.ok(text.includes(concept.slice(0, 6)), `${path.basename(f)} contient ${concept}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
