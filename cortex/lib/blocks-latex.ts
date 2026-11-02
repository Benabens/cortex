import { currentCourse } from "@/db/client";
import type { ExamBlock, BlockPart } from "@/lib/blocks";
import { getCourse } from "@/lib/courses";
import { compileExamPdf } from "@/lib/exam-latex";
import { getFormatProfile } from "@/lib/format";
import { examsDir } from "@/lib/paths";
import { copyExamLogo, coverHeader, esc, examDocument } from "@/lib/qcm-latex";
import { assertTexSafe } from "@/lib/tex-guard";
import fs from "node:fs";
import path from "node:path";

/**
 * PDF d'un examen à QUESTIONS COMPOSÉES (lib/blocks), au look des examens QCM du moteur
 * (même préambule, même garde) : par question, le scénario puis ses sous-questions (a),
 * (b)… avec leurs points, cases à cocher pour le choix unique, cadre de code et lignes de
 * réponse. Corrigé : bonne option, sortie exacte du code, réponse modèle et barème.
 * Tout le texte vient du modèle et passe par `esc` (jamais de LaTeX libre).
 */
const LETTER = "ABCDEFGH".split("");
const BOX = String.raw`\ding{113}`;
const TICK = String.raw`\ding{51}`;

/**
 * Un extrait de code en police à chasse fixe, espaces et lignes vides conservés. Chaque ligne
 * commence par \mbox{} : sans lui, TeX supprime l'indentation après un saut de ligne forcé, et
 * une ligne qui commence par « [ » ou « * » serait lue comme un argument de \\.
 */
function codeTex(code: string): string {
  const lines = code.replace(/\t/g, "    ").replace(/\s+$/, "").split("\n").map((l) => String.raw`\mbox{}` + esc(l).replace(/ /g, "\\ "));
  return String.raw`\par\smallskip\noindent\fbox{\parbox{\dimexpr\linewidth-2\fboxsep-2\fboxrule\relax}{\ttfamily\small ` + lines.join("\\\\\n") + "}}\\par\\smallskip";
}

/** Texte du modèle : paragraphes échappés, blocs ```…``` en cadre de code. */
function richTex(s: string): string {
  const out: string[] = [];
  let last = 0;
  for (const m of s.matchAll(/```[\w+-]*\n?([\s\S]*?)```/g)) {
    out.push(paragraphs(s.slice(last, m.index)));
    out.push(codeTex(m[1]));
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(paragraphs(s.slice(last)));
  return out.filter(Boolean).join("\n");
}

function paragraphs(s: string): string {
  return s.split(/\n\s*\n/).map((p) => esc(p.trim()).replace(/\n/g, String.raw`\\ `)).filter(Boolean).map((p) => String.raw`\noindent ${p}\par\smallskip`).join("\n");
}

const pts = (n: number) => `${n} pt${n > 1 ? "s" : ""}`;

function renderPart(p: BlockPart, i: number, withKey: boolean): string {
  const head = String.raw`\par\medskip\needspace{4\baselineskip}\noindent\textbf{(${LETTER[i].toLowerCase()})}\quad{\footnotesize[${pts(p.points)}]}\quad ${esc(p.prompt)}\par\smallskip`;
  const body: string[] = [];
  if (p.kind === "scq") {
    body.push(...p.options.map((o, k) => String.raw`\noindent\hspace*{1em}${withKey && k === p.correct ? TICK : BOX}~\textbf{${LETTER[k]}.}~${esc(o)}\par\smallskip`));
  } else if (p.kind === "code_output") {
    body.push(codeTex(p.code));
    body.push(withKey ? String.raw`\noindent{\color{epflred}\textbf{Output:}}` + "\n" + codeTex(p.answer) : String.raw`\noindent Output:\rulelines{3}`);
  } else {
    body.push(withKey
      ? [
          String.raw`\noindent{\color{epflred}\textbf{Model answer:}} ${esc(p.answer)}\par\smallskip`,
          String.raw`\noindent{\footnotesize\textbf{Grading:}}\par`,
          ...p.criteria.map((c) => String.raw`\noindent\hspace*{1em}{\footnotesize --- ${esc(c.label)} (${pts(c.points)})}\par`),
        ].join("\n")
      : String.raw`\rulelines{4}`);
  }
  if (withKey && p.explanation) body.push(String.raw`\par{\footnotesize\color{epflred}\textbf{Solution:} ${esc(p.explanation)}}\par`);
  return [head, ...body].join("\n");
}

function renderBlock(b: ExamBlock, n: number, withKey: boolean): string {
  return [
    String.raw`\par\bigskip\needspace{8\baselineskip}\noindent{\large\textbf{Question ${n} \quad-- ${esc(b.title)}} \hfill [${pts(b.points)}]}\par\vspace{3pt}\hrule\vspace{8pt}`,
    richTex(b.scenario),
    ...b.parts.map((p, i) => renderPart(p, i, withKey)),
  ].join("\n");
}

async function cover(dateLabel: string, n: number, totalPts: number, durationMin: number): Promise<string> {
  return [
    ...coverHeader(dateLabel, durationMin),
    String.raw`\vspace{0.4cm}\par\noindent{\large\textbf{Instructions}}\par\smallskip\small`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{3pt}`,
    `\\item This exam has \\textbf{${n} questions}, each made of a short scenario or code excerpt followed by sub-questions, for a total of \\textbf{${totalPts} points}. You have ${durationMin} minutes.`,
    String.raw`\item Single-choice sub-questions have exactly one correct answer: tick its box \fbox{$\checkmark$}. For code excerpts, write the exact output. Short answers take one to three sentences.`,
    String.raw`\item A one-page two-sided cheat sheet is allowed. No electronic device is permitted.`,
    String.raw`\item Answer directly on this exam sheet, in the space provided.`,
    String.raw`\end{enumerate}\vspace{0.3cm}`,
  ].filter(Boolean).join("\n");
}

/** Source .tex complet de l'examen à questions composées, corrigé optionnel. */
export async function renderBlocksTex(blocks: ExamBlock[], dateLabel: string, withKey: boolean): Promise<string> {
  const fmt = await getFormatProfile();
  const duration = fmt?.duration_min || getCourse(currentCourse()).durationMin || 90;
  const total = blocks.reduce((s, b) => s + b.points, 0);
  return examDocument([
    await cover(dateLabel, blocks.length, total, duration),
    String.raw`\clearpage`,
    ...blocks.map((b, i) => renderBlock(b, i + 1, withKey)),
  ], dateLabel);
}

/**
 * Écrit énoncé + corrigé .tex (le garde passe avant toute écriture) et compile les deux PDF.
 * Un échec n'est jamais silencieux : `texError` (l'examen reste consultable en ligne et se
 * recompile sans le modèle) ; `file` vide si aucun .tex sûr n'a pu être écrit.
 */
export async function buildBlocksArtifact(examId: number, blocks: ExamBlock[], dateLabel: string): Promise<{ file: string; texError?: string; texWarning?: string }> {
  fs.mkdirSync(examsDir(), { recursive: true });
  copyExamLogo();
  const base = `blocks-${examId}`;
  const write = async (withKey: boolean): Promise<string> => {
    const tex = await renderBlocksTex(blocks, dateLabel, withKey);
    assertTexSafe(tex);
    const name = withKey ? `${base}-corrige` : base;
    fs.writeFileSync(path.join(examsDir(), `${name}.tex`), tex);
    return name;
  };
  let pdf: string;
  try {
    pdf = await compileExamPdf(await write(false));
  } catch (e) {
    return { file: fs.existsSync(path.join(examsDir(), `${base}.tex`)) ? `${base}.tex` : "", texError: (e as Error).message };
  }
  try {
    await compileExamPdf(await write(true));
  } catch (e) {
    console.error(`[blocks] corrigé #${examId} non compilé :`, (e as Error).message);
    return { file: pdf, texWarning: `corrigé non compilé : ${(e as Error).message.slice(0, 200)}` };
  }
  return { file: pdf };
}
