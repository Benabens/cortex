/**
 * LaTeX — le .tex compilé contient du texte issu du modèle. Avant compilation,
 * un garde REJETTE toute primitive de lecture/écriture de fichier et tout
 * détournement de catcode ; il ne modifie JAMAIS le source : le .tex d'un
 * examen normal reste byte-identique (empreinte canonique de la CI).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-texguard-"));
process.env.CORTEX_DATA_DIR = tmp; // lu au chargement de lib/courses → imports DYNAMIQUES ci-dessous

type RunWithCourse = typeof import("../db/client").runWithCourse;
let runWithCourse: RunWithCourse;

const SPEC = {
  title: "CS-202 Computer Systems — Final Exam",
  duration_min: 180,
  questions: [
    { category: "Networking", concept: "Subnets and packets", points: 50, statement_tex: "\\subq{1.1}{X}{10} Body $R_1$.\\packetgrid{12}", solution_tex: "Sol A." },
    { category: "OS", concept: "Inodes", points: 25, statement_tex: "\\subq{3.1}{Y}{8} Body.\\diskgrid{8}", solution_tex: "Sol B." },
  ],
};
const CANONICAL_TEX_SHA = "9a294bb25e9d919c"; // .github/workflows/ci.yml — invariant de non-régression
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

before(async () => {
  delete process.env.CORTEX_USER;
  ({ runWithCourse } = await import("../db/client"));
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => { delete process.env.CORTEX_DATA_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

test("le .tex d'un examen normal est byte-identique et passe le garde", async () => {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { assertTexSafe, findTexHazards } = await import("../lib/tex-guard");
  const tex = await runWithCourse("cs-202", async () => renderExamTex(SPEC as never, "2026-06-11", true));
  assert.equal(sha(tex), CANONICAL_TEX_SHA, "le rendu .tex canonique a changé");
  assert.deepEqual(findTexHazards(tex), []);
  assertTexSafe(tex); // ne lève pas, ne modifie rien
});

test("les primitives dangereuses sont rejetées, une par une", async () => {
  const { findTexHazards } = await import("../lib/tex-guard");
  const cases = [
    String.raw`\input{/etc/passwd}`,
    String.raw`\input{../../.env}`,
    String.raw`\include{secret}`,
    String.raw`\InputIfFileExists{/etc/hosts}{}{}`,
    String.raw`\openin\myfile=/etc/passwd`,
    String.raw`\read\myfile to \x`,
    String.raw`\lstinputlisting{/etc/passwd}`,
    String.raw`\verbatiminput{/etc/passwd}`,
    String.raw`\immediate\write18{id}`,
    String.raw`\openout\out=x`,
    String.raw`\catcode`+"`"+String.raw`\%=12`,
    String.raw`\csname input\endcsname{/etc/passwd}`,
    String.raw`\^^69nput{x}`,
    String.raw`\includegraphics{/etc/passwd}`,
    String.raw`\includegraphics{../uploads/secret.png}`,
    String.raw`\includegraphics[width=3cm]{"/abs/path"}`,
    String.raw`\directlua{os.execute("id")}`,
    String.raw`\usepackage{shellesc}`,
    String.raw`\graphicspath{{/}}`,
    String.raw`\import{/etc/}{passwd}`,
    String.raw`\CatchFileDef{\x}{/etc/passwd}{}`,
    // Vecteurs vérifiés sous tectonic --untrusted : une liste de noms ne suffit pas.
    String.raw`\begin{@@input}/etc/passwd\end{@@input}`,
    String.raw`\ExplSyntaxOn \file_input:n{/etc/passwd} \ExplSyntaxOff`,
    String.raw`\ExplSyntaxOn \ior_open:Nn \g_tmpa_ior {/etc/passwd} \ExplSyntaxOff`,
    String.raw`\XeTeXpdffile "/data/u/autre/exams/exam-1.pdf" page 1`,
    String.raw`\XeTeXpicfile "/etc/x.png"`,
    String.raw`\begin{filecontents}{piege.tex}x\end{filecontents}`,
    String.raw`\begin{filecontents*}{piege.tex}x\end{filecontents*}`,
    String.raw`\begin{csname}input\end{csname}`,
    String.raw`\begin{environnementinconnu}x\end{environnementinconnu}`,
    // Lot 2b-5 : contournements de la forme des motifs (vérifiés sous tectonic --untrusted,
    // qui LIT les fichiers hors dossier : le garde est la seule barrière).
    String.raw`\UseName{@@input}{/etc/passwd}`,
    String.raw`\ExpandArgs{c}\use{@@input}{/etc/passwd}`,
    String.raw`\@nameuse{@@input}{/etc/passwd}`,
    String.raw`\def\x{@@input}\begin\x{/etc/passwd}`,
    String.raw`\def\x{document}\end\x`,
    String.raw`\begin \x`,
    String.raw`\includegraphics*{/etc/passwd}`,
    String.raw`\includegraphics*[width=2cm]{../../secret.png}`,
    String.raw`\def\p{{/etc/passwd}}\includegraphics\p`,
    String.raw`\includegraphics [width=2cm] \p`,
    String.raw`\pgfimage{/etc/passwd}`,
    String.raw`\pgfimage[width=2cm]{fig.png}`,
    String.raw`\pgfdeclareimage[width=2cm]{x}{/etc/passwd}`,
    String.raw`\IfFileExists{/etc/passwd}{oui}{non}`,
    // Revue : primitives pdfTeX reprises par XeTeX — lecture (hexadécimale) et oracles sur un fichier arbitraire.
    String.raw`\filedump length 40 {/app/cortex/.env}`,
    String.raw`\filedump offset 0 length 8 {../outside/secret.txt}`,
    String.raw`\filesize{/etc/passwd}`,
    String.raw`\filemoddate{/etc/passwd}`,
    String.raw`\mdfivesum file {/etc/passwd}`,
    String.raw`\pdffilesize{/etc/passwd}`,
    String.raw`\shellescape`,
  ];
  for (const c of cases) {
    const body = `\\begin{document}\nTexte ${c} texte\n\\end{document}`;
    assert.ok(findTexHazards(body).length > 0, `non détecté : ${c}`);
  }
});

test("ce qui est légitime passe : figures relatives, macros du cours, maths", async () => {
  const { findTexHazards } = await import("../lib/tex-guard");
  const ok = [
    String.raw`\begin{center}\includegraphics[width=0.52\linewidth]{fig-3f2a1c.png}\end{center}`,
    String.raw`\includegraphics[width=4cm]{figref/lab4-inode.png}`,
    String.raw`\subq{1.1}{X}{10} Soit $R_1$ le routeur. \packetgrid{12} \textbf{readable} \emph{file} inputs`,
    String.raw`\begin{tabular}{|c|c|}\hline a & b \\ \hline\end{tabular} \examq{1}{Inodes}{25}`,
    String.raw`\verb|input.txt| et \texttt{fichier d'entrée}`,
    // Macros locales qu'un corrigé emploie couramment : sans \csname ni \catcode, elles ne fabriquent rien.
    String.raw`\def\R{\mathbb{R}} \let\eps\varepsilon \newcommand{\norm}[1]{\lVert #1 \rVert} $\norm{x} \in \R$`,
    String.raw`\expandafter\textbf\expandafter{\eps} \uppercase{abc} \lowercase{DEF}`,
    // Environnements courants d'un énoncé/corrigé.
    String.raw`\begin{enumerate}\item a \begin{itemize}\item b\end{itemize}\end{enumerate} \begin{align*} x &= 1 \\ y &= 2 \end{align*}`,
    String.raw`\begin{tabular}{|l|c|}\hline a & b \\ \hline\end{tabular} \begin{center}\begin{minipage}{0.5\textwidth}x\end{minipage}\end{center}`,
    String.raw`$\begin{pmatrix} 1 & 0 \\ 0 & 1 \end{pmatrix}$ \begin{cases} 1 & x>0 \\ 0 & \text{sinon} \end{cases} \begin{verbatim}int main(){}\end{verbatim}`,
    String.raw`\begin{lstlisting}[language=C]\nprintf("x");\n\end{lstlisting} \begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture} \begin{figure}[h]\centering x\end{figure}`,
  ];
  for (const c of ok) assert.deepEqual(findTexHazards(c), [], `faux positif : ${c}`);
});

test("buildExamArtifact refuse un examen piégé AVANT d'écrire ou compiler quoi que ce soit", async () => {
  const { buildExamArtifact } = await import("../lib/exam-latex");
  const { examsDir } = await import("../lib/paths");
  const piege = {
    ...SPEC,
    questions: [{ ...SPEC.questions[0], statement_tex: String.raw`\subq{1.1}{X}{10} Body \input{/etc/passwd}` }],
  };
  await runWithCourse("cs-202", async () => {
    await assert.rejects(() => buildExamArtifact(piege as never, 777, "2026-06-11"), /LaTeX|refusé|dangereu/i);
    const dir = examsDir();
    const written = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("exam-777")) : [];
    assert.deepEqual(written, [], "des fichiers ont été écrits pour un examen refusé");
  });
});

test("tectonic est lancé avec --untrusted quand la version le supporte", async () => {
  const { tectonicArgs } = await import("../lib/exam-latex");
  const args = tectonicArgs("exam-1.tex", { untrustedSupported: true });
  assert.ok(args.includes("--untrusted"), args.join(" "));
  assert.equal(args[args.length - 1], "exam-1.tex");
  const legacy = tectonicArgs("exam-1.tex", { untrustedSupported: false });
  assert.ok(!legacy.includes("--untrusted"));
});
