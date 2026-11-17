/**
 * RELEVÉ DE LA MISE EN PAGE D'UNE ANNALE (lib/exam-layout-survey) : déterministe, sans appel au
 * modèle. Trois annales FICTIVES de styles différents (tests/fixtures/annales/*.tex : un QCM
 * américain à cinq options, un examen anglais à rédaction, un examen français) ; leurs mots et
 * boîtes (`pdftotext -bbox-layout`) et leurs polices (`pdffonts`) sont figés à côté, pour un test
 * pur. Le dernier test recompile les annales et relit le PDF (sauté sans tectonic ni poppler).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { guessLanguage, parseBboxXhtml, parsePdffonts, surveyAnnalePdfs, surveyPages } from "../lib/exam-layout-survey";

const DIR = path.join(__dirname, "fixtures", "annales");
const read = (name: string, ext: string) => fs.readFileSync(path.join(DIR, `${name}.${ext}`), "utf8");
const survey = (name: string) => surveyPages(parseBboxXhtml(read(name, "bbox.html")), parsePdffonts(read(name, "fonts.txt")));

test("QCM américain : sans empattements en 10 pt, « (A) » et bulles sur deux colonnes, page n sur total, pas de barème par question", () => {
  const s = survey("us-mcq");
  assert.deepEqual(s.font, { family: "sans", size: 10 });
  assert.deepEqual(s.choices, { label: "(A)", mark: "bubble", columns: 2 });
  assert.deepEqual(s.header, { left: "course", center: "none", right: "none" });
  assert.deepEqual(s.footer, { left: "none", center: "pageOfTotal", right: "none" });
  assert.deepEqual(s.numbering, { prefix: "", style: "arabic" });
  assert.equal(s.points, "none");
  assert.deepEqual(s.cover?.idFields, [{ kind: "name", label: "Name:" }, { kind: "studentId", label: "NetID:" }, { kind: "signature", label: "Signature:" }]);
  assert.equal(s.language, "en");
});

test("examen anglais à rédaction : 12 pt avec empattements, barème en marge, numéro de candidat et de table", () => {
  const s = survey("uk-essay");
  assert.deepEqual(s.font, { family: "serif", size: 12 });
  assert.equal(s.points, "margin");
  assert.deepEqual(s.header, { left: "none", center: "none", right: "course" });
  assert.deepEqual(s.footer, { left: "none", center: "page", right: "none" });
  assert.equal(s.choices, undefined, "pas d'options dans un examen à rédaction");
  assert.deepEqual(s.cover?.idFields?.map((f) => f.label), ["Candidate number:", "Desk number:"]);
});

test("consignes : celles qui ne valent que pour l'annale (nombre de questions, sections, cahier) sont écartées", () => {
  assert.deepEqual(survey("uk-essay").cover?.instructions, ["Do not turn over this page until instructed to do so."]);
  assert.deepEqual(survey("us-mcq").cover?.instructions, [
    "Fill in the bubble of the single best answer for each question.",
    "Calculators are permitted; phones must be turned off.",
    "There is no penalty for guessing.",
  ]);
});

test("examen français : « Exercice » en chiffres romains, barème dans la ligne, cours et type d'examen en tête", () => {
  const s = survey("fr-examen");
  assert.deepEqual(s.numbering, { prefix: "Exercice", style: "roman" });
  assert.equal(s.points, "inline");
  assert.deepEqual(s.header, { left: "course", center: "none", right: "examKind" });
  assert.deepEqual(s.footer, { left: "none", center: "none", right: "pageOfTotal" });
  assert.deepEqual(s.cover?.idFields?.map((f) => f.label), ["Nom :", "Prénom :", "Numéro d’étudiant :"]);
  assert.deepEqual(s.cover?.instructions, ["Aucun document n’est autorisé.", "Les calculatrices sont interdites.", "La qualité de la rédaction sera prise en compte."]);
  assert.equal(s.language, "fr");
});

test("rien de lisible : aucun champ relevé (le défaut neutre s'applique)", () => {
  assert.deepEqual(surveyPages([], []), {});
  assert.deepEqual(surveyPages([{ width: 595, height: 842, lines: [] }], []), {});
});

test("langue des consignes", () => {
  assert.equal(guessLanguage("Les calculatrices sont interdites. Aucun document n'est autorisé."), "fr");
  assert.equal(guessLanguage("Phones must be turned off and the use of notes is not allowed."), "en");
  assert.equal(guessLanguage("Calculators"), null);
});

test("de bout en bout : les annales recompilées se relisent comme leurs fixtures (sauté sans tectonic ni poppler)", (t) => {
  if (spawnSync("tectonic", ["--version"]).error || spawnSync("pdftotext", ["-v"]).error) return t.skip("tectonic ou pdftotext absent");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-survey-"));
  try {
    for (const name of ["us-mcq", "uk-essay", "fr-examen"]) {
      const c = spawnSync("tectonic", ["-o", out, path.join(DIR, `${name}.tex`)], { encoding: "utf8", timeout: 300_000 });
      if (c.status !== 0) return t.skip(`tectonic n'a pas compilé ${name} (paquets hors du cache ?)`);
      assert.deepEqual(surveyAnnalePdfs([path.join(out, `${name}.pdf`)]), survey(name), name);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
