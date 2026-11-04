/**
 * Une figure générée qui ne compile pas ne fait plus tomber tout le PDF — banc moteur du 04/11/2026
 * (CS-202) : « Missing \endgroup inserted » dans le nœud d'un arbre de processus (examproctree),
 * ligne 648 ; énoncé et corrigé en repli HTML pour cinq exercices justes. La compilation retire la
 * figure fautive (un encadré le dit) et recompile. Le message d'erreur ne cite plus le bruit du
 * paquet qrcode (« Error-correction level increased… »).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-latex-fig-"));
process.env.CORTEX_DATA_DIR = tmp;
after(() => { delete process.env.CORTEX_DATA_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

const TEX = [
  "\\documentclass{article}", "\\usepackage{tikz}", "\\begin{document}", "Exercice 1 : un énoncé juste.", "",
  "\\begin{center}", "\\begin{tikzpicture}", "\\node (a) {\\undefinedmacro};", "\\end{tikzpicture}", "\\end{center}", "",
  "Exercice 2 : la suite.", "\\end{document}", "",
].join("\n");

test("la figure qui contient la ligne fautive est retirée, le reste du document intact", async () => {
  const { dropFailingFigure } = await import("../lib/exam-latex");
  const out = dropFailingFigure(TEX, 8);
  assert.ok(out, "une figure a été retirée");
  assert.doesNotMatch(out!, /undefinedmacro|tikzpicture/);
  assert.match(out!, /Figure retirée/);
  assert.match(out!, /Exercice 1 : un énoncé juste\.[\s\S]*Exercice 2 : la suite\./);
  assert.equal(dropFailingFigure(TEX, 4), null, "ligne hors de toute figure : rien à retirer");
  const inline = "Texte\nCalcule \\undefinedmacro{FPR} \\begin{tikzpicture}\\node {a};\\end{tikzpicture} avec 37 \\%.\nFin";
  assert.equal(dropFailingFigure(inline, 2), null, "figure en ligne dans du texte : jamais retirée avec la ligne");
});

test("la ligne fautive est celle de l'erreur, pas d'un avertissement qui la précède", async () => {
  const { failingLine } = await import("../lib/exam-latex");
  assert.equal(failingLine("warning: exam-1.tex:85: Underfull \\hbox\nerror: exam-1.tex:648: Missing \\endgroup inserted"), 648);
  assert.equal(failingLine("! Missing \\endgroup inserted.\n<to be read again>\nl.648 \\begin{examproctree}"), 648);
});

let hasTectonic = true;
try { execFileSync("which", ["tectonic"], { stdio: "ignore" }); } catch { hasTectonic = false; }

test("compileExamPdf : figure cassée → PDF produit sans elle", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  const { compileExamPdf } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  fs.mkdirSync(examsDir(), { recursive: true });
  fs.writeFileSync(path.join(examsDir(), "fig-cassee.tex"), TEX);
  assert.equal(await compileExamPdf("fig-cassee"), "fig-cassee.pdf");
  assert.ok(fs.existsSync(path.join(examsDir(), "fig-cassee.pdf")));
});
