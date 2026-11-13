/**
 * Aperçu HTML des énoncés (texToHtml, page /mock) et résumé d'examen (écran Examens, MCP) :
 *  - un `tabular` devient un vrai tableau, découpé au niveau supérieur seulement (maths,
 *    environnements et tableaux imbriqués intacts), sans LaTeX brut à l'écran ;
 *  - les ligatures `--` / `---` ne touchent ni les maths ni le code ;
 *  - le résumé s'accorde au singulier et réécrit l'ancien format abrégé stocké en base.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { texToHtml } from "../lib/exam-latex";
import { examSummaryLabel, qcmSummaryText } from "../lib/exam-summary";

const rows = (html: string) => [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]));

test("tabular → <table> : lignes, cellules, \\& et \\hline, sans LaTeX brut", () => {
  const html = texToHtml(String.raw`\begin{tabular}{|c|c|}\hline $t$ & état \\ \hline 1 & A \& B \\ \hline\end{tabular}`);
  assert.match(html, /^<div class="tab"><table>/);
  assert.deepEqual(rows(html), [["<em>t</em>", "état"], ["1", "A &amp; B"]]);
  assert.doesNotMatch(html, /hline|tabular|\\\\/);
});

test("tabular : découpe au niveau supérieur seulement", () => {
  // & dans des maths, tableau imbriqué, colonne à deux niveaux d'accolades, \multicolumn, \\[2pt]
  const pm = rows(texToHtml(String.raw`\begin{tabular}{cc} M & $\begin{pmatrix}1 & 2\\3 & 4\end{pmatrix}$ \\ \end{tabular}`));
  assert.equal(pm.length, 1);
  assert.equal(pm[0].length, 2);
  const nested = texToHtml(String.raw`\begin{tabular}{cc} a & \begin{tabular}{c} x \\ y \end{tabular} \\ b & c \end{tabular} après`);
  assert.equal((nested.match(/<table>/g) ?? []).length, 2);
  assert.match(nested, /<\/div> après$/);
  assert.deepEqual(rows(texToHtml(String.raw`\begin{tabular}{p{\widthof{abc}}c} u & v \\ \end{tabular}`)), [["u", "v"]]);
  const multi = texToHtml(String.raw`\begin{tabular}{cc} \multicolumn{2}{p{3cm}}{Titre} \\[2pt] a & b \end{tabular}`);
  assert.match(multi, /<td colspan="2">Titre<\/td>/);
  assert.deepEqual(rows(multi)[1], ["a", "b"]);
});

test("tabular : un bloc de code dans une cellule est rendu, pas « undefined »", () => {
  const html = texToHtml("\\begin{tabular}{c} \\begin{verbatim}\nint i;\n\\end{verbatim} \\\\ \\end{tabular}");
  assert.match(html, /<td><pre class="code">int i;<\/pre><\/td>/);
  assert.doesNotMatch(html, /undefined/);
});

test("ligatures -- et --- hors maths et hors code", () => {
  const html = texToHtml(String.raw`Lance \texttt{gcc --version} puis \texttt{i--} ; texte --- fin, pages 3--5 ; $a--b$`);
  assert.match(html, /<code>gcc --version<\/code>/);
  assert.match(html, /<code>i--<\/code>/);
  assert.match(html, /texte — fin, pages 3–5/);
  assert.match(html, /<em>a--b<\/em>/);
});

test("résumé d'examen : accord au singulier, aucun vérifié, examen incomplet", () => {
  assert.equal(qcmSummaryText({ count: 1, requested: 1, verified: 1, open: 0, openRequested: 0 }), "1 QCM vérifié");
  assert.equal(qcmSummaryText({ count: 16, requested: 16, verified: 16, open: 2, openRequested: 2 }), "16 QCM vérifiés · 2 questions ouvertes");
  assert.equal(qcmSummaryText({ count: 3, requested: 3, verified: 1, open: 1, openRequested: 1 }), "3 QCM, dont 1 vérifié · 1 question ouverte");
  assert.equal(qcmSummaryText({ count: 3, requested: 7, verified: 0, open: 0, openRequested: 2 }), "QCM : 3 sur 7 demandés, dont aucun vérifié · 0 question ouverte sur 2");
});

test("résumé d'examen : l'ancien format stocké en base est réécrit à la lecture", () => {
  assert.equal(examSummaryLabel("QCM 16 (16 vér.) + 2 ouverte(s)"), "16 QCM vérifiés · 2 questions ouvertes");
  assert.equal(examSummaryLabel("QCM 5 sur 7 demandés (4 vér.) + 1 sur 3 ouverte(s) — questions ouvertes en cours"), "QCM : 5 sur 7 demandés, dont 4 vérifiés · 1 question ouverte sur 3, questions ouvertes en cours");
  assert.equal(examSummaryLabel(null), null);
});
