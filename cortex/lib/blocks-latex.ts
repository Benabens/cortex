import type { ExamBlock, BlockPart } from "@/lib/blocks";
import { compileExamPdf, copyExamLogo } from "@/lib/exam-latex";
import { examDurationMin } from "@/lib/exam-format";
import { examLayout, examPdf, type BlockLabels, type ExamLayout } from "@/lib/exam-layout";
import { examsDir } from "@/lib/paths";
import { examDocument } from "@/lib/qcm-latex";
import { esc } from "@/lib/tex-escape";
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

function renderPart(p: BlockPart, i: number, withKey: boolean, L: BlockLabels): string {
  const { pts } = L;
  const head = String.raw`\par\medskip\needspace{4\baselineskip}\noindent\textbf{(${LETTER[i].toLowerCase()})}\quad{\footnotesize[${pts(p.points)}]}\quad ${esc(p.prompt)}\par\smallskip`;
  const body: string[] = [];
  if (p.kind === "scq") {
    body.push(...p.options.map((o, k) => String.raw`\noindent\hspace*{1em}${withKey && k === p.correct ? TICK : BOX}~\textbf{${LETTER[k]}.}~${esc(o)}\par\smallskip`));
  } else if (p.kind === "code_output") {
    body.push(codeTex(p.code));
    body.push(withKey ? String.raw`\noindent{\color{${L.color}}\textbf{${L.output}}}` + "\n" + codeTex(p.answer) : String.raw`\noindent ${L.output}\rulelines{3}`);
  } else {
    body.push(withKey
      ? [
          String.raw`\noindent{\color{${L.color}}\textbf{${L.modelAnswer}}} ${esc(p.answer)}\par\smallskip`,
          String.raw`\noindent{\footnotesize\textbf{${L.grading}}}\par`,
          ...p.criteria.map((c) => String.raw`\noindent\hspace*{1em}{\footnotesize --- ${esc(c.label)} (${pts(c.points)})}\par`),
        ].join("\n")
      : String.raw`\rulelines{4}`);
  }
  if (withKey && p.explanation) body.push(String.raw`\par{\footnotesize\color{${L.color}}\textbf{${L.solution}} ${esc(p.explanation)}}\par`);
  return [head, ...body].join("\n");
}

function renderBlock(b: ExamBlock, n: number, withKey: boolean, L: BlockLabels): string {
  return [
    String.raw`\par\bigskip\needspace{8\baselineskip}\noindent{\large\textbf{${L.question} ${n} \quad-- ${esc(b.title)}} \hfill [${L.pts(b.points)}]}\par\vspace{3pt}\hrule\vspace{8pt}`,
    richTex(b.scenario),
    ...b.parts.map((p, i) => renderPart(p, i, withKey, L)),
  ].join("\n");
}

/** Source .tex complet de l'examen à questions composées, corrigé optionnel. */
export async function renderBlocksTex(blocks: ExamBlock[], dateLabel: string, withKey: boolean, layout?: ExamLayout): Promise<string> {
  const pdf = examPdf(layout ?? (await examLayout()));
  const duration = await examDurationMin();
  const total = blocks.reduce((s, b) => s + b.points, 0);
  return examDocument([
    await pdf.cover({ form: "blocks", dateLabel, n: blocks.length, totalPts: total, durationMin: duration }),
    String.raw`\clearpage`,
    ...blocks.map((b, i) => renderBlock(b, i + 1, withKey, pdf.blocks)),
  ], dateLabel, pdf);
}

/**
 * Écrit énoncé + corrigé .tex (le garde passe avant toute écriture) et compile les deux PDF.
 * Un échec n'est jamais silencieux : `texError` (l'examen reste consultable en ligne et se
 * recompile sans le modèle) ; `file` vide si aucun .tex sûr n'a pu être écrit.
 */
export async function buildBlocksArtifact(examId: number, blocks: ExamBlock[], dateLabel: string): Promise<{ file: string; texError?: string; texWarning?: string }> {
  fs.mkdirSync(examsDir(), { recursive: true });
  copyExamLogo(examPdf(await examLayout()).logo);
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
