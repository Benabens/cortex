/**
 * RENDU PARAMÉTRIQUE de la mise en page (lib/exam-layout-pdf, lib/exam-layout-tex) : chaque champ
 * de l'ExamLayout change ce qu'il doit changer dans le .tex des trois moteurs, et rien d'autre.
 * Le défaut neutre reste byte-identique (empreintes de tests/exam-layout). Cours et examens
 * FICTIFS (tests/helpers/gabarits.ts).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ExamLayout } from "../lib/exam-layout";
import type { GabaritCourses } from "./helpers/gabarits";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-layout-rendu-"));
process.env.CORTEX_DATA_DIR = tmp;

let ids: GabaritCourses;
let NEUTRAL: ExamLayout;

before(async () => {
  const { createGabaritCourses } = await import("./helpers/gabarits");
  ids = await createGabaritCourses();
  NEUTRAL = (await import("../lib/exam-layout")).NEUTRAL_LAYOUT;
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Patch = { [K in keyof ExamLayout]?: ExamLayout[K] extends object ? Partial<ExamLayout[K]> : ExamLayout[K] };
const variant = (p: Patch): ExamLayout => {
  const out = { ...NEUTRAL, source: "annale" } as ExamLayout;
  const base = NEUTRAL as unknown as Record<string, object>;
  for (const [k, v] of Object.entries(p)) (out as unknown as Record<string, unknown>)[k] = typeof v === "object" && !Array.isArray(v) ? { ...base[k], ...v } : v;
  return out;
};

/** Énoncé et corrigé des trois formes dans le cours neutre anglais, avec la mise en page `layout`. */
async function renders(layout: ExamLayout): Promise<{ written: string; qcm: string; qcmKey: string; blocks: string }> {
  const { runWithCourse } = await import("../db/client");
  const { renderExamTex } = await import("../lib/exam-latex");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const { WRITTEN_SPEC, QCM_DATA, BLOCKS, DATE } = await import("./helpers/gabarits");
  return runWithCourse(ids.neutralEn, async () => ({
    written: await renderExamTex(WRITTEN_SPEC as never, DATE, true, layout),
    qcm: await renderQcmExamTex(QCM_DATA, DATE, false, layout),
    qcmKey: await renderQcmExamTex(QCM_DATA, DATE, true, layout),
    blocks: await renderBlocksTex(BLOCKS, DATE, false, layout),
  }));
}

const body = (tex: string) => tex.slice(tex.lastIndexOf(String.raw`\begin{document}`));

test("numérotation de l'annale : « Exercice » en chiffres romains, dans les trois moteurs", async () => {
  const r = await renders(variant({ numbering: { prefix: "Exercice", style: "roman" } }));
  assert.match(r.written, /\\renewcommand\{\\examq\}\[3\]\{[^\n]*\\textbf\{Exercice \\Roman\{exq\} \\quad-- #2/);
  assert.match(r.written, /\\textbf\{Exercice II \\quad-- /, "titre du corrigé");
  assert.match(body(r.qcm), /\\textbf\{Exercice II\.\}/);
  assert.match(body(r.blocks), /\\textbf\{Exercice I \\quad-- /);
});

test("numéro seul et préfixe d'une lettre : « 3. » et « Q3. »", async () => {
  assert.match(body((await renders(variant({ numbering: { prefix: "", style: "arabic" } }))).qcm), /\\noindent\\textbf\{2\.\}\\quad/);
  assert.match(body((await renders(variant({ numbering: { prefix: "Q", style: "arabic" } }))).qcm), /\\noindent\\textbf\{Q2\.\}\\quad/);
});

test("options : lettres entre parenthèses et bulles ; le corrigé garde la coche", async () => {
  const r = await renders(variant({ choices: { label: "(a)", mark: "bubble" } }));
  assert.match(body(r.qcm), /\$\\bigcirc\$~\\textbf\{\(a\)\}~/);
  assert.match(body(r.qcm), /\\textbf\{\(c\)\}/);
  assert.doesNotMatch(body(r.qcm), /\\ding\{113\}/, "plus de case");
  assert.match(body(r.qcmKey), /\\ding\{51\}~\\textbf\{\(/);
});

test("options sans marque : la lettre seule", async () => {
  const r = await renders(variant({ choices: { label: "A)", mark: "none" } }));
  assert.match(body(r.qcm), /\\noindent\\textbf\{A\)\}~/);
});

test("options sur deux colonnes : deux par ligne dans l'énoncé, une colonne dans le corrigé", async () => {
  const r = await renders(variant({ choices: { columns: 2 } }));
  assert.match(body(r.qcm), /\\begin\{minipage\}\[t\]\{0\.48\\linewidth\}[^\n]*\\hfill\\begin\{minipage\}/);
  assert.doesNotMatch(body(r.qcmKey), /minipage\}\[t\]\{0\.48/);
  assert.doesNotMatch(r.qcm, /usepackage\{multicol\}/, "aucun paquet hors du cache de tectonic");
});

test("barème dans la ligne : entre parenthèses, plus à droite", async () => {
  const r = await renders(variant({ points: "inline" }));
  assert.match(r.written, /#2 \(#3 points\)\}\}/);
  assert.match(body(r.qcm), /\\footnotesize\[single choice\]\}\\quad\\textbf\{\\textit\{[^}]*\}\} \(\d+ points?\)\\par/);
  assert.match(body(r.blocks), /\(\d+ points?\)\}\}\\par\\vspace\{3pt\}/);
});

test("barème absent : aucun point dans les titres, le total reste sur la garde", async () => {
  const r = await renders(variant({ points: "none" }));
  assert.match(r.written, /\\textbf\{Question #1 \\quad-- #2\}\}/);
  assert.doesNotMatch(body(r.qcm).split("\\clearpage")[1] ?? "", /\\footnotesize\[[^\]]*points?\]/);
  assert.match(body(r.qcm), /Total:/);
});

test("police : sans empattements et 12 pt", async () => {
  const r = await renders(variant({ font: { family: "sans", size: 12 } }));
  for (const tex of [r.written, r.qcm, r.blocks]) {
    assert.match(tex, /\\documentclass\[12pt,a4paper\]\{article\}/);
    assert.match(tex, /\\renewcommand\{\\familydefault\}\{\\sfdefault\}/);
  }
});

test("en-tête et pied : « page 3/5 » au centre du pied, le cours à droite de l'en-tête", async () => {
  const r = await renders(variant({ header: { left: "none", center: "none", right: "course" }, footer: { left: "none", center: "pageOfTotal", right: "none" } }));
  // Le chrome de la mise en page, après le préambule de cs-202 qui a ses propres cases.
  for (const tex of [r.written, r.qcm, r.blocks].map((t) => t.slice(t.lastIndexOf(String.raw`\examchromefalse`)))) {
    assert.match(tex, /\\fancyhead\[R\]\{\\small [^}]+\}/);
    assert.doesNotMatch(tex, /\\fancyhead\[L\]/);
    assert.match(tex, /\\fancyfoot\[C\]\{\\small\\thepage\/\\pageref\{cortex-last-page\}\}/);
    assert.match(tex, /\\AtEndDocument\{\\label\{cortex-last-page\}\}/);
  }
});

test("garde : champs et consignes de l'annale, tableau des points", async () => {
  const r = await renders(variant({
    cover: {
      idFields: [{ kind: "name", label: "Name:" }, { kind: "studentId", label: "NetID:" }, { kind: "signature", label: "Signature:" }],
      instructions: ["Calculators are permitted; phones must be turned off.", "There is no penalty for guessing & no partial credit."],
      pointsTable: true,
    },
  }));
  const cover = body(r.written).split("\\clearpage")[0];
  assert.match(cover, /\\noindent Name:~\\makebox\[0\.5\\textwidth\]\{\\hrulefill\}\\hfill NetID:~/);
  assert.match(cover, /\\noindent Signature:~\\makebox\[0\.6\\textwidth\]/);
  assert.match(cover, /\\item Calculators are permitted; phones must be turned off\./);
  assert.match(cover, /guessing \\& no partial/, "consignes échappées");
  // La ligne qui dit ce que contient l'examen reste en tête, les consignes génériques s'effacent.
  assert.match(cover, /\\item The exam consists of 2 independent exercises/);
  assert.doesNotMatch(cover, /directly on the exam sheet/);
  assert.match(cover, /\\begin\{tabular\}\{\|c\|c\|c\|/);
});

test("espaces de réponse : cadre ou blanc à la place des lignes", async () => {
  assert.match((await renders(variant({ answerSpace: "box" }))).qcm, /\\renewcommand\{\\rulelines\}\[1\]\{[^\n]*\\fbox/);
  assert.match((await renders(variant({ answerSpace: "blank" }))).qcm, /\\renewcommand\{\\rulelines\}\[1\]\{\\par\\vspace/);
});

test("une mise en page relevée ne porte aucune marque de l'EPFL", async () => {
  const r = await renders(variant({ numbering: { prefix: "Problem", style: "arabic" }, choices: { label: "(A)", mark: "bubble", columns: 2 }, points: "inline", font: { family: "sans", size: 10 } }));
  for (const tex of [r.written, r.qcm, r.blocks]) assert.doesNotMatch(body(tex), /\\epfllogo|SCIPER|Anonymi|qrcode|epflred/i);
});

test("compile : la mise en page la plus éloignée du défaut, dans les trois moteurs (sauté sans tectonic ni pdftotext)", async (t) => {
  const { compileExamPdf, texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable() || spawnSync("pdftotext", ["-v"]).error) return t.skip("tectonic/pdflatex ou pdftotext absent");
  const { examsDir } = await import("../lib/paths");
  const r = await renders(variant({
    numbering: { prefix: "", style: "roman" }, choices: { label: "(a)", mark: "bubble", columns: 2 }, points: "inline",
    font: { family: "sans", size: 12 }, answerSpace: "box",
    header: { left: "none", center: "course", right: "none" }, footer: { left: "none", center: "none", right: "pageOfTotal" },
    cover: { idFields: [{ kind: "studentId", label: "Candidate number:" }], instructions: ["Phones off."], pointsTable: true },
  }));
  fs.mkdirSync(examsDir(), { recursive: true });
  for (const [name, tex] of Object.entries({ "layout-written": r.written, "layout-qcm": r.qcm, "layout-blocks": r.blocks })) {
    fs.writeFileSync(path.join(examsDir(), `${name}.tex`), tex);
    await compileExamPdf(name);
    const text = execFileSync("pdftotext", [path.join(examsDir(), `${name}.pdf`), "-"]).toString();
    assert.match(text, /Candidate number:/, name);
    assert.match(text, /\d+\/\d+/, `${name} : « page n/total » au pied`);
    assert.doesNotMatch(text, /\?\?/, `${name} : référence de dernière page non résolue`);
  }
});
