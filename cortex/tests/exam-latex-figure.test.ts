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

test("macros de babel-french sans babel (\\og, \\fg) : remplacées dans tout le document si l'erreur en vient", async () => {
  const { repairFrenchMacros } = await import("../lib/exam-latex");
  const tex = "Ligne 1\nselon laquelle \\og le seuil \\fg{} est fixe, puis \\og encore \\fg.\nLe 1\\ier{} cas.";
  const out = repairFrenchMacros(tex, 2);
  assert.ok(out);
  assert.doesNotMatch(out!, /\\og|\\fg|\\ier/);
  assert.match(out!, /« le seuil »/);
  assert.equal(repairFrenchMacros(tex.replace(/\\og|\\fg/g, ""), 2), null, "rien de babel sur la ligne : pas de réparation");
});

test("compileExamPdf : un \\og sans babel ne fait plus tomber le PDF", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  const { compileExamPdf } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  fs.writeFileSync(path.join(examsDir(), "og.tex"), "\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\begin{document}\nSelon \\og le cours \\fg, le seuil est fixe.\n\\end{document}\n");
  assert.equal(await compileExamPdf("og"), "og.pdf");
});

test("compileExamPdf : un _ nu dans \\texttt (SEEK_CUR) ne fait plus tomber le PDF", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  // Banc moteur du 15/11/2026 (cs-202-ecrit) : « Missing $ inserted » sur \texttt{lseek(fd2, -2, SEEK_CUR)},
  // cinq exercices livrés sans PDF. Les maths et un \_ déjà échappé restent tels quels.
  const { compileExamPdf } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  fs.writeFileSync(path.join(examsDir(), "souligne.tex"), [
    "\\documentclass{article}", "\\usepackage[T1]{fontenc}", "\\begin{document}",
    "Le thread B exécute \\texttt{lseek(fd2, -2, SEEK_CUR)} puis \\texttt{open(p, O\\_RDONLY)} ; on note $x_1$.",
    "\\end{document}", "",
  ].join("\n"));
  assert.equal(await compileExamPdf("souligne"), "souligne.pdf");
});

test("compileExamPdf : un % nu dans \\texttt (printf) ne fait plus tomber le PDF", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  // Banc exam-cout du 17/11/2026 (cs-202-ecrit) : \texttt{printf("%s", p17->msg);} — le « % » met la fin de
  // la ligne en commentaire, \texttt ne se ferme plus (« File ended while scanning use of \texttt ») : examen sans PDF.
  const { compileExamPdf } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  fs.writeFileSync(path.join(examsDir(), "pourcent.tex"), [
    "\\documentclass{article}", "\\usepackage[T1]{fontenc}", "\\begin{document}",
    "\\begin{itemize}", "\\item $T_{mon}$ (plus tard) : \\texttt{printf(\"%s\", p17->msg);}", "\\item Taux : 37 \\% des requêtes.", "\\end{itemize}",
    "\\end{document}", "",
  ].join("\n"));
  assert.equal(await compileExamPdf("pourcent"), "pourcent.pdf");
});

test("compileExamPdf : l'écriture inclusive en \\cdot hors maths (étudiant\\cdot es) ne fait plus tomber le PDF", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  // Banc exam-cout du 17/11/2026 (cs-202-ecrit) : « trois étudiant\cdot es », « chacun\cdot e » hors maths :
  // « Missing $ inserted », examen sans PDF. Le produit des maths ($p \cdot e$) reste tel quel.
  const { compileExamPdf } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  const tex = [
    "\\documentclass{article}", "\\usepackage[T1]{fontenc}", "\\begin{document}",
    "Pendant un lab, trois étudiant\\cdot es développent un serveur ; on calcule $p \\cdot e$.",
    "A, B, C soumettent chacun\\cdot e une review.",
    "\\end{document}", "",
  ].join("\n");
  fs.writeFileSync(path.join(examsDir(), "inclusif.tex"), tex);
  assert.equal(await compileExamPdf("inclusif"), "inclusif.pdf");
  assert.match(fs.readFileSync(path.join(examsDir(), "inclusif.tex"), "utf8"), /\$p \\cdot e\$/);
});

test("compileExamPdf : les « \\n » littéraux (double échappement JSON) deviennent des retours à la ligne", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  // Banc exam-cout du 17/11/2026 (cs-202-ecrit, 3 examens sur 8 livrés sans PDF) : « avec \texttt{P}.\n\nÉtat
  // mémoire… » — un « \n » tapé deux fois échappé dans le JSON arrive en macro inconnue. Le code reste du code :
  // dans \texttt, « \n » s'écrit, et un listing n'est pas touché.
  const { compileExamPdf } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  fs.writeFileSync(path.join(examsDir(), "retours.tex"), [
    "\\documentclass{article}", "\\usepackage[T1]{fontenc}", "\\usepackage{listings}", "\\usepackage{tikz}", "\\newcommand{\\nrows}{3}", "\\begin{document}",
    "\\begin{tikzpicture}\\node (a) {A};\\end{tikzpicture} sur \\nrows{} lignes.",
    "Le processus \\texttt{R} se partage le CPU avec \\texttt{P}.\\n\\nÉtat mémoire courant : \\texttt{printf(\"ok\\n\")}.\\nIl reste \\noindent 3 pages, $\\nu \\neq 0$.\\na) Suite.",
    "\\begin{lstlisting}", "printf(\"%d\\n\", x);", "\\end{lstlisting}",
    "\\end{document}", "",
  ].join("\n"));
  assert.equal(await compileExamPdf("retours"), "retours.pdf");
  const out = fs.readFileSync(path.join(examsDir(), "retours.tex"), "utf8");
  assert.match(out, /avec \\texttt\{P\}\.\n\nÉtat/);
  assert.match(out, /printf\("%d\\n", x\);/, "le listing garde son \\n");
  assert.match(out, /\\node \(a\) \{A\};\\end\{tikzpicture\} sur \\nrows\{\}/, "\\node (TikZ) et une macro du document restent des macros");
  assert.match(out, /\.\nIl reste \\noindent 3 pages, \$\\nu \\neq 0\$\.\na\) Suite/, "« \\nIl », « \\na) » : des retours ; \\noindent, \\nu, \\neq : des macros");
});

test("compileExamPdf : \\xcancel sans le paquet cancel ne fait plus tomber le PDF", { skip: hasTectonic ? false : "tectonic absent" }, async () => {
  // Banc exam-cout du 17/11/2026 (cs-202-ecrit) : « 6 & \multicolumn{7}{c}{\xcancel{non utilisée}} » dans un corrigé.
  const { compileExamPdf } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  fs.writeFileSync(path.join(examsDir(), "barre.tex"), [
    "% le corps est injecté après \\begin{document}).", "\\documentclass{article}", "\\usepackage[T1]{fontenc}", "\\begin{document}",
    "\\begin{tabular}{c|ccccccc}", "5 & 1 & 2 & 3 & 4 & 5 & 6 & 7 \\\\", "6 & \\multicolumn{7}{c}{\\xcancel{non utilisée}} \\\\", "\\end{tabular}",
    "\\end{document}", "",
  ].join("\n"));
  assert.equal(await compileExamPdf("barre"), "barre.pdf");
});
